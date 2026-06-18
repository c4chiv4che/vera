#!/bin/bash
set -euo pipefail
exec > >(tee -a /var/log/vera-user-data.log) 2>&1

echo "=== vera-user-data: starting at $(date) ==="

# Install Docker (Amazon Linux 2023 uses dnf, not yum)
dnf install -y docker
systemctl enable --now docker

# Wait for Docker to be ready
until docker info > /dev/null 2>&1; do
  echo "Waiting for Docker daemon..."
  sleep 2
done

# Login to ECR using the instance profile credentials
aws ecr get-login-password --region ${region} | \
  docker login --username AWS --password-stdin ${ecr_repo_url}

# Pull and run the gateway image
IMAGE="${ecr_repo_url}:${image_tag}"
docker pull "$IMAGE"

docker run -d \
  --name vera-gateway \
  --restart unless-stopped \
  --network host \
  --log-driver=awslogs \
  --log-opt awslogs-region=${region} \
  --log-opt awslogs-group=${log_group_name} \
  --log-opt awslogs-stream="gateway/$(hostname)" \
  "$IMAGE"

echo "=== vera-user-data: completed at $(date) ==="
