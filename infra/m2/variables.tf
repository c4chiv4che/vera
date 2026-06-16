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
