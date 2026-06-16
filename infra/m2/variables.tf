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
