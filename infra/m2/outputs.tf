output "vpc_id" {
  value       = aws_vpc.main.id
  description = "ID of the Vera M2 VPC"
}

output "public_subnet_ids" {
  value       = aws_subnet.public[*].id
  description = "IDs of the two public subnets (one per AZ)"
}

output "vpc_cidr" {
  value       = aws_vpc.main.cidr_block
  description = "CIDR block of the VPC"
}

output "gateway_security_group_id" {
  value       = aws_security_group.gateway.id
  description = "Security group ID for the Vera SIP/RTP gateway"
}

output "task_role_arn" {
  value       = aws_iam_role.task.arn
  description = "ARN of the IAM role assumed by the gateway EC2 instance (via instance profile) — used by the app at runtime"
}

output "ecr_repository_url" {
  value       = aws_ecr_repository.gateway.repository_url
  description = "ECR repository URL for the gateway image (use for docker push)"
}

output "log_group_name" {
  value       = aws_cloudwatch_log_group.gateway.name
  description = "CloudWatch log group for the gateway task"
}

output "gateway_public_ip" {
  value       = aws_eip.gateway.public_ip
  description = "Stable public IP of the gateway — use in Connect's outbound route Host field"
}

output "gateway_instance_id" {
  value       = aws_instance.gateway.id
  description = "EC2 instance ID — use for SSM Session Manager"
}

output "gateway_ssm_connect_command" {
  value       = "aws ssm start-session --target ${aws_instance.gateway.id} --region ${var.region}"
  description = "Ready-to-paste command for SSM Session Manager into the gateway"
}
