variable "region" {
  description = "AWS region for Vera M2 infrastructure"
  type        = string
  default     = "us-east-1"
}

variable "vpc_cidr" {
  description = "CIDR block for the Vera M2 VPC"
  type        = string
  default     = "10.0.0.0/16"
}

# TODO(M2-prod): when the Connect external voice transfer connector goes live,
# replace 0.0.0.0/0 with the documented AWS Chime/Connect SIP IP ranges
# (https://docs.aws.amazon.com/general/latest/gr/aws-ip-ranges.html, service
# "CHIME_VOICECONNECTOR"). 0.0.0.0/0 is acceptable only while iterating from
# a developer machine as the SIP source.
variable "allowed_sip_cidrs" {
  description = "CIDR ranges allowed to send SIP/RTP to the gateway"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "nova_sonic_model_arn" {
  description = "Bedrock foundation model ARN for Amazon Nova Sonic. Region-pinned because Nova Sonic is only in us-east-1."
  type        = string
  default     = "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-sonic-v1:0"
}

# Image tag to deploy from the ECR repository. The full image URI is
# constructed in main.tf as "${aws_ecr_repository.gateway.repository_url}:${var.gateway_image_tag}"
# so the account ID stays out of the source tree.
# 'dev' is the convention for the local-build tag pushed manually during
# M2; a real CI pipeline would push tags like 'sha-<git>' or 'v1.2.3'.
variable "gateway_image_tag" {
  description = "Tag of the gateway image in ECR to deploy (e.g. 'dev', 'sha-abc123', 'v1.0.0')"
  type        = string
  default     = "dev"
}

variable "instance_type" {
  description = "EC2 instance type for the gateway. t3.medium provides 2 vCPU / 4 GB RAM — enough headroom for pjsua2 + Strands + future piper-tts."
  type        = string
  default     = "t3.medium"
}
