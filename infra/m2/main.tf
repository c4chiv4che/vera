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

# ----------------------------------------------------------------------------
# IAM — Task Execution Role (used by ECS itself to start the task)
# ----------------------------------------------------------------------------
# This role is assumed by the ECS agent on Fargate. It needs to pull the
# image from ECR and write task-level logs to CloudWatch. Nothing app-level.

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "vera-m2-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = {
    Name = "vera-m2-task-execution"
    Role = "ECSInfrastructure"
  }
}

# AWS-managed policy that covers ECR pull + CloudWatch Logs writes.
resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ----------------------------------------------------------------------------
# IAM — Task Role (used by the app code inside the container)
# ----------------------------------------------------------------------------
# Least-privilege: only what the gateway actually needs at runtime.

resource "aws_iam_role" "task" {
  name               = "vera-m2-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

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

  # Optional: write app-level logs if the gateway code uses boto3 logs
  # client directly (uncommon in Fargate — the container's stdout is
  # already captured by the execution role's CloudWatch wiring).
  # Left here as a stub — uncomment only if the app needs it.
  #
  # statement {
  #   sid       = "AppLogs"
  #   actions   = ["logs:PutLogEvents", "logs:CreateLogStream"]
  #   resources = ["${aws_cloudwatch_log_group.gateway.arn}:*"]
  # }
}

resource "aws_iam_role_policy" "task_app" {
  name   = "vera-m2-task-app"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_app.json
}
