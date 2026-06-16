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
