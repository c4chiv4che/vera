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

output "task_execution_role_arn" {
  value       = aws_iam_role.task_execution.arn
  description = "ARN of the ECS task execution role (used by ECS to start tasks)"
}

output "task_role_arn" {
  value       = aws_iam_role.task.arn
  description = "ARN of the ECS task role (used by the app at runtime)"
}

output "ecr_repository_url" {
  value       = aws_ecr_repository.gateway.repository_url
  description = "ECR repository URL for the gateway image (use for docker push)"
}

output "log_group_name" {
  value       = aws_cloudwatch_log_group.gateway.name
  description = "CloudWatch log group for the gateway task"
}

output "ecs_cluster_name" {
  value       = aws_ecs_cluster.main.name
  description = "ECS cluster name"
}

output "ecs_service_name" {
  value       = aws_ecs_service.gateway.name
  description = "ECS service name (for force-new-deployment commands)"
}
