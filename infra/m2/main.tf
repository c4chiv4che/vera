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
# ECS — Cluster + Task Definition + Service (Fargate)
# ----------------------------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = "vera-m2"

  setting {
    name  = "containerInsights"
    value = "disabled" # paid feature, off for POC
  }

  tags = {
    Name = "vera-m2-cluster"
  }
}

# Cluster capacity providers — Fargate only, no Spot for now.
resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# Task definition for the gateway. Image URI is built from the ECR
# repository URL (resource-resolved, account ID never appears in the
# source) plus the var.gateway_image_tag. To deploy a new image:
# 1) docker push <ecr_url>:<tag>
# 2) update var.gateway_image_tag (or rely on the default 'dev')
# 3) terraform apply  — ECS does a rolling deploy with the new task def.
resource "aws_ecs_task_definition" "gateway" {
  family                   = "vera-m2-gateway"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]

  execution_role_arn = aws_iam_role.task_execution.arn
  task_role_arn      = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "gateway"
      image     = "${aws_ecr_repository.gateway.repository_url}:${var.gateway_image_tag}"
      essential = true

      portMappings = [
        # SIP signaling
        {
          containerPort = 5060
          hostPort      = 5060
          protocol      = "udp"
        }
        # RTP port range is NOT declared here on purpose: ECS task def
        # accepts only single ports, not ranges. The security group
        # opens 10000-20000 already; the container binds whichever
        # ports pjsua decides at runtime within that range.
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.gateway.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "gateway"
        }
      }
    }
  ])

  tags = {
    Name = "vera-m2-gateway-taskdef"
  }
}

# Service — 1 task always running, in our public subnets, with the
# gateway SG. Public IPs are assigned automatically (no NLB yet —
# Connect will reach the task directly via its public IP once we
# wire the External Voice Transfer Connector).
resource "aws_ecs_service" "gateway" {
  name            = "vera-m2-gateway"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.gateway.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.gateway.id]
    assign_public_ip = true
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # Wait for steady state but don't fail terraform if it takes long
  # (Fargate cold-start can be 30-60s).
  wait_for_steady_state = false

  tags = {
    Name = "vera-m2-gateway-service"
  }

  # If the task definition changes outside Terraform (e.g. by a
  # CI/CD pipeline that pushes a new image revision), don't fight
  # over it. For now we don't have CI/CD, so leave commented.
  # lifecycle {
  #   ignore_changes = [task_definition]
  # }
}
