data "archive_file" "crm_lambda_zip" {
  type        = "zip"
  source_file = "${path.module}/lambda/handler.py"
  output_path = "${path.module}/lambda/build/handler.zip"
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "crm_lambda" {
  name               = "${var.lambda_function_name}-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_cloudwatch_log_group" "crm_lambda" {
  name              = "/aws/lambda/${var.lambda_function_name}"
  retention_in_days = 14
}

data "aws_iam_policy_document" "crm_lambda" {
  statement {
    sid     = "DynamoDBGetItemOnClientesTable"
    effect  = "Allow"
    actions = ["dynamodb:GetItem"]
    resources = [
      aws_dynamodb_table.clientes.arn,
    ]
  }

  statement {
    sid    = "CloudWatchLogsForThisFunction"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${aws_cloudwatch_log_group.crm_lambda.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "crm_lambda" {
  name   = "${var.lambda_function_name}-policy"
  role   = aws_iam_role.crm_lambda.id
  policy = data.aws_iam_policy_document.crm_lambda.json
}

resource "aws_lambda_function" "crm" {
  function_name = var.lambda_function_name
  role          = aws_iam_role.crm_lambda.arn
  runtime       = "python3.12"
  handler       = "handler.handler"

  filename         = data.archive_file.crm_lambda_zip.output_path
  source_code_hash = data.archive_file.crm_lambda_zip.output_base64sha256

  timeout     = 10
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.clientes.name
    }
  }

  depends_on = [
    aws_iam_role_policy.crm_lambda,
    aws_cloudwatch_log_group.crm_lambda,
  ]
}
