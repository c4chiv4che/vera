variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Named AWS CLI profile used by the provider."
  type        = string
  default     = "vera"
}

variable "table_name" {
  description = "DynamoDB table name for the simulated FSI CRM."
  type        = string
  default     = "vera-fsi-clientes"
}

variable "lambda_function_name" {
  description = "Name of the CRM Lambda function."
  type        = string
  default     = "vera-fsi-crm"
}

variable "api_stage_name" {
  description = "API Gateway deployment stage."
  type        = string
  default     = "demo"
}
