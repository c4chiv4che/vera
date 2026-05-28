import json
import os
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

TABLE_NAME = os.environ["TABLE_NAME"]

_dynamodb = boto3.resource("dynamodb")
_table = _dynamodb.Table(TABLE_NAME)


def _decode(value):
    if isinstance(value, Decimal):
        if value % 1 == 0:
            return int(value)
        return float(value)
    if isinstance(value, list):
        return [_decode(v) for v in value]
    if isinstance(value, dict):
        return {k: _decode(v) for k, v in value.items()}
    return value


def _response(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, ensure_ascii=False),
    }


def handler(event, _context):
    path_params = event.get("pathParameters") or {}
    dni = path_params.get("dni")

    if not dni:
        return _response(400, {"error": "missing path parameter 'dni'"})

    try:
        result = _table.get_item(Key={"dni": dni})
    except ClientError as err:
        return _response(500, {"error": err.response["Error"]["Message"]})

    item = result.get("Item")
    if not item:
        return _response(404, {"error": "cliente no encontrado", "dni": dni})

    return _response(200, _decode(item))
