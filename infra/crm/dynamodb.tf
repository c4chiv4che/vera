resource "aws_dynamodb_table" "clientes" {
  name         = var.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "dni"

  attribute {
    name = "dni"
    type = "S"
  }
}

resource "aws_dynamodb_table_item" "cliente_raul" {
  table_name = aws_dynamodb_table.clientes.name
  hash_key   = aws_dynamodb_table.clientes.hash_key

  item = jsonencode({
    dni             = { S = "28456789" }
    nombre          = { S = "Raúl Gómez" }
    ingreso_mensual = { N = "2000" }
    deuda_mensual   = { N = "600" }
    credit_score    = { N = "690" }
  })
}

resource "aws_dynamodb_table_item" "cliente_laura" {
  table_name = aws_dynamodb_table.clientes.name
  hash_key   = aws_dynamodb_table.clientes.hash_key

  item = jsonencode({
    dni             = { S = "31234567" }
    nombre          = { S = "Laura Fernández" }
    ingreso_mensual = { N = "5000" }
    deuda_mensual   = { N = "500" }
    credit_score    = { N = "740" }
  })
}

resource "aws_dynamodb_table_item" "cliente_diego" {
  table_name = aws_dynamodb_table.clientes.name
  hash_key   = aws_dynamodb_table.clientes.hash_key

  item = jsonencode({
    dni             = { S = "20111222" }
    nombre          = { S = "Diego Sosa" }
    ingreso_mensual = { N = "1800" }
    deuda_mensual   = { N = "950" }
    credit_score    = { N = "560" }
  })
}
