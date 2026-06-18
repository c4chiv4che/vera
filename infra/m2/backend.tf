# Backend config is passed via -backend-config to keep the account ID
# out of the public repo. See backend.hcl.example for the template.
terraform {
  backend "s3" {}
}
