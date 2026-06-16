output "endpoint_url" {
  description = "Invoke URL for GET /clientes/{dni}."
  value       = "${aws_api_gateway_stage.demo.invoke_url}/clientes/{dni}"
}

output "dynamodb_table_name" {
  description = "Name of the CRM DynamoDB table."
  value       = aws_dynamodb_table.clientes.name
}

output "api_key" {
  description = "API key value required by the x-api-key header."
  value       = aws_api_gateway_api_key.crm.value
  sensitive   = true
}
