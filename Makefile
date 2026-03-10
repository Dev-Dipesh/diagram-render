.DEFAULT_GOAL := help

# Optional variables for the render target
FILE ?=
DIR  ?=
OUT  ?=

.PHONY: help render up down restart status

help: ## Show available commands
	@echo ""
	@echo "Commands:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Examples:"
	@echo "  make render                              render all diagrams in src/"
	@echo "  make render FILE=public/flow.puml        render a single file"
	@echo "  make render DIR=src/public               render src/public → diagrams/public"
	@echo "  make render DIR=src/private              render src/private → diagrams/private"
	@echo "  make render DIR=src/public OUT=out/pub   override output directory"
	@echo ""

render: ## Render diagrams — FILE=, DIR=, OUT= are optional
	node generate.cjs \
		$(if $(FILE),$(FILE),) \
		$(if $(DIR),-i $(DIR),) \
		$(if $(OUT),-o $(OUT),)

up: ## Start all Kroki containers in detached mode
	docker compose up -d

down: ## Stop and remove all Kroki containers
	docker compose down

restart: ## Restart all Kroki containers in detached mode
	docker compose restart

status: ## Show Kroki container status
	docker compose ps
