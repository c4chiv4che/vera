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
