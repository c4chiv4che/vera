resource "aws_api_gateway_rest_api" "crm" {
  name        = "vera-fsi-crm-api"
  description = "Vera FSI CRM REST API (demo)."
}

resource "aws_api_gateway_resource" "clientes" {
  rest_api_id = aws_api_gateway_rest_api.crm.id
  parent_id   = aws_api_gateway_rest_api.crm.root_resource_id
  path_part   = "clientes"
}

resource "aws_api_gateway_resource" "cliente_dni" {
  rest_api_id = aws_api_gateway_rest_api.crm.id
  parent_id   = aws_api_gateway_resource.clientes.id
  path_part   = "{dni}"
}

resource "aws_api_gateway_method" "get_cliente" {
  rest_api_id      = aws_api_gateway_rest_api.crm.id
  resource_id      = aws_api_gateway_resource.cliente_dni.id
  http_method      = "GET"
  authorization    = "NONE"
  api_key_required = true

  request_parameters = {
    "method.request.path.dni" = true
  }
}

resource "aws_api_gateway_integration" "get_cliente" {
  rest_api_id             = aws_api_gateway_rest_api.crm.id
  resource_id             = aws_api_gateway_resource.cliente_dni.id
  http_method             = aws_api_gateway_method.get_cliente.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.crm.invoke_arn
}

resource "aws_lambda_permission" "apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.crm.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.crm.execution_arn}/*/*"
}

resource "aws_api_gateway_deployment" "crm" {
  rest_api_id = aws_api_gateway_rest_api.crm.id

  triggers = {
    redeploy = sha1(jsonencode([
      aws_api_gateway_resource.clientes.id,
      aws_api_gateway_resource.cliente_dni.id,
      aws_api_gateway_method.get_cliente.id,
      aws_api_gateway_integration.get_cliente.id,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    aws_api_gateway_method.get_cliente,
    aws_api_gateway_integration.get_cliente,
  ]
}

resource "aws_api_gateway_stage" "demo" {
  rest_api_id   = aws_api_gateway_rest_api.crm.id
  deployment_id = aws_api_gateway_deployment.crm.id
  stage_name    = var.api_stage_name
}

resource "aws_api_gateway_api_key" "crm" {
  name        = "vera-fsi-crm-key"
  description = "API key for the Vera FSI CRM demo."
  enabled     = true
}

resource "aws_api_gateway_usage_plan" "crm" {
  name        = "vera-fsi-crm-usage-plan"
  description = "Usage plan binding the CRM API key to the demo stage."

  api_stages {
    api_id = aws_api_gateway_rest_api.crm.id
    stage  = aws_api_gateway_stage.demo.stage_name
  }
}

resource "aws_api_gateway_usage_plan_key" "crm" {
  key_id        = aws_api_gateway_api_key.crm.id
  key_type      = "API_KEY"
  usage_plan_id = aws_api_gateway_usage_plan.crm.id
}
