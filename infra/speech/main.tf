# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = "= 1.12.6"

  required_providers {
    azapi = {
      source  = "Azure/azapi"
      version = "= 2.12.0"
    }
  }
}

locals {
  subscription_id = "e4f89284-8be8-403e-994b-9c49736281c8"
}

provider "azapi" {
  subscription_id            = local.subscription_id
  tenant_id                  = "3751bf45-67e0-47a1-a5d2-9a80c44d5a3c"
  use_cli                    = true
  skip_provider_registration = true
  disable_default_output     = true
}

resource "azapi_resource" "speech" {
  type      = "Microsoft.CognitiveServices/accounts@2025-06-01"
  parent_id = "/subscriptions/${local.subscription_id}/resourceGroups/rg-monitoring"
  name      = "financeVoiceIndia"
  location  = "centralindia"

  tags = {
    application = "finance-agent"
    environment = "development"
    purpose     = "realtimeVoice"
  }

  body = {
    kind = "SpeechServices"
    sku = {
      name = "S0"
    }
    properties = {
      publicNetworkAccess = "Enabled"
    }
  }
}