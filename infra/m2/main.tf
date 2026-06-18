# ============================================================================
# Vera Phase D — M2 infrastructure
# Owner: c4chiv4che (Habib)
# Single-file layout for now. Split when reading becomes painful.
# ============================================================================

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "Vera"
      ManagedBy = "Terraform"
      Phase     = "D-M2"
    }
  }
}

# Pick the first two AZs available in the region. Avoids hardcoding.
data "aws_availability_zones" "available" {
  state = "available"
}

# ----------------------------------------------------------------------------
# VPC + networking base
# ----------------------------------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "vera-m2-vpc"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "vera-m2-igw"
  }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "vera-m2-public-${count.index}"
    Tier = "Public"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "vera-m2-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ----------------------------------------------------------------------------
# Security group for the SIP/RTP gateway
# ----------------------------------------------------------------------------

resource "aws_security_group" "gateway" {
  name        = "vera-m2-gateway-sg"
  description = "SIP signaling + RTP media for the Vera telephony gateway"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "vera-m2-gateway-sg"
  }
}

# SIP signaling
resource "aws_vpc_security_group_ingress_rule" "sip_udp" {
  for_each          = toset(var.allowed_sip_cidrs)
  security_group_id = aws_security_group.gateway.id
  description       = "SIP signaling (UDP 5060)"
  ip_protocol       = "udp"
  from_port         = 5060
  to_port           = 5060
  cidr_ipv4         = each.value
}

# RTP media (pjsua default range)
resource "aws_vpc_security_group_ingress_rule" "rtp_udp" {
  for_each          = toset(var.allowed_sip_cidrs)
  security_group_id = aws_security_group.gateway.id
  description       = "RTP media (UDP 10000-20000)"
  ip_protocol       = "udp"
  from_port         = 10000
  to_port           = 20000
  cidr_ipv4         = each.value
}

# Egress: everything (Bedrock, CloudWatch, ECR, SIP back to Connect)
resource "aws_vpc_security_group_egress_rule" "all_outbound" {
  security_group_id = aws_security_group.gateway.id
  description       = "Allow all outbound traffic"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

# ----------------------------------------------------------------------------
# IAM — Task Role (used by the app code inside the container)
# ----------------------------------------------------------------------------
# Least-privilege: only what the gateway actually needs at runtime.

resource "aws_iam_role" "task" {
  name               = "vera-m2-task"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json

  tags = {
    Name = "vera-m2-task"
    Role = "ApplicationRuntime"
  }
}

data "aws_iam_policy_document" "task_app" {
  # Nova Sonic — the only Bedrock model this gateway talks to.
  # bedrock:InvokeModel is the action; InvokeModelWithBidirectionalStream
  # is the API but it maps to this single IAM action.
  statement {
    sid       = "NovaSonicInvoke"
    actions   = ["bedrock:InvokeModel"]
    resources = [var.nova_sonic_model_arn]
  }

  # Docker's awslogs driver writes container stdout/stderr to this log
  # group. Scoped to the specific log group ARN — least privilege.
  statement {
    sid = "AwsLogsDriver"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.gateway.arn}:*"]
  }

  # ECR pull — replaces the previous task execution role (gone with
  # Fargate). GetAuthorizationToken doesn't support resource-level
  # constraints, so it's scoped to *. The rest are scoped to our repo.
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPull"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
    ]
    resources = [aws_ecr_repository.gateway.arn]
  }
}

resource "aws_iam_role_policy" "task_app" {
  name   = "vera-m2-task-app"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_app.json
}

# ----------------------------------------------------------------------------
# ECR — registry for the gateway Docker image
# ----------------------------------------------------------------------------

resource "aws_ecr_repository" "gateway" {
  name                 = "vera-m2-gateway"
  image_tag_mutability = "MUTABLE" # MUTABLE during POC; switch to IMMUTABLE for prod
  force_delete         = true      # allow terraform destroy even if images present

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "vera-m2-gateway"
  }
}

# Lifecycle policy: keep the 10 most recent images, expire the rest.
resource "aws_ecr_lifecycle_policy" "gateway" {
  repository = aws_ecr_repository.gateway.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the 10 most recent images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# ----------------------------------------------------------------------------
# CloudWatch Log Group for the gateway task
# ----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "gateway" {
  name              = "/ecs/vera-m2-gateway"
  retention_in_days = 7

  tags = {
    Name = "vera-m2-gateway-logs"
  }
}

# ----------------------------------------------------------------------------
# AMI — Amazon Linux 2023 (latest stable, x86_64, HVM, Amazon-owned)
# ----------------------------------------------------------------------------

data "aws_ami" "amazon_linux_2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023*-x86_64"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ----------------------------------------------------------------------------
# EC2 instance profile — wraps the task role so EC2 can assume it
# ----------------------------------------------------------------------------

resource "aws_iam_instance_profile" "gateway" {
  name = "vera-m2-gateway-instance-profile"
  role = aws_iam_role.task.name

  tags = {
    Name = "vera-m2-gateway-instance-profile"
  }
}

# ----------------------------------------------------------------------------
# Gateway EC2 instance — Docker with host networking for SIP/RTP
# ----------------------------------------------------------------------------
# user_data installs Docker, logs into ECR, pulls the gateway image, and
# runs it with --network host (so pjsua can bind the full UDP range
# 10000-20000) and --log-driver=awslogs (so container stdout flows to
# CloudWatch — same log group M2.1 used).

resource "aws_instance" "gateway" {
  ami           = data.aws_ami.amazon_linux_2023.id
  instance_type = var.instance_type
  subnet_id     = aws_subnet.public[0].id

  vpc_security_group_ids = [aws_security_group.gateway.id]
  iam_instance_profile   = aws_iam_instance_profile.gateway.name

  user_data = templatefile("${path.module}/user_data.sh.tpl", {
    region         = var.region
    ecr_repo_url   = aws_ecr_repository.gateway.repository_url
    image_tag      = var.gateway_image_tag
    log_group_name = aws_cloudwatch_log_group.gateway.name
  })
  user_data_replace_on_change = true

  metadata_options {
    http_tokens   = "required" # IMDSv2 only
    http_endpoint = "enabled"
  }

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  tags = {
    Name = "vera-m2-gateway"
  }
}

# ----------------------------------------------------------------------------
# Elastic IP — stable public endpoint for Amazon Connect outbound routes
# ----------------------------------------------------------------------------
# The EIP is what Connect's "Outbound routes" config will point to (Host
# field, with Port 5060 + UDP). It survives instance reboots and persists
# across terraform taint of the instance — that's the M2.2 invariant.

resource "aws_eip" "gateway" {
  domain = "vpc"

  tags = {
    Name = "vera-m2-gateway-eip"
  }
}

resource "aws_eip_association" "gateway" {
  instance_id   = aws_instance.gateway.id
  allocation_id = aws_eip.gateway.id
}
