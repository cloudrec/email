SHELL := /bin/bash
COMPOSE := docker compose
PROJECT := email

.PHONY: help up down restart logs ps health build pull migrate seed backup restore shell-api shell-db clean

help:
	@echo "Email Platform - make targets"
	@echo "  make up          - start core stack"
	@echo "  make down        - stop stack (keep volumes)"
	@echo "  make restart     - restart services"
	@echo "  make logs        - tail logs"
	@echo "  make ps          - list running services"
	@echo "  make health      - run scripts/healthcheck.sh"
	@echo "  make build       - rebuild local images"
	@echo "  make pull        - pull external images"
	@echo "  make migrate     - run DB migrations"
	@echo "  make seed        - seed initial data (super admin, plans)"
	@echo "  make backup      - run scripts/backup.sh"
	@echo "  make restore F=  - run scripts/restore.sh on backup file F"
	@echo "  make shell-api   - shell into api container"
	@echo "  make shell-db    - mysql shell into db"
	@echo "  make clean       - remove containers but keep volumes"

up:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) restart

logs:
	$(COMPOSE) logs -f --tail=200

ps:
	$(COMPOSE) ps

health:
	bash scripts/healthcheck.sh

build:
	$(COMPOSE) build

pull:
	$(COMPOSE) pull

migrate:
	$(COMPOSE) exec api node /app/dist/cli/migrate.js

seed:
	$(COMPOSE) exec api node /app/dist/cli/seed.js

backup:
	bash scripts/backup.sh

restore:
	bash scripts/restore.sh "$(F)"

shell-api:
	$(COMPOSE) exec api sh

shell-db:
	$(COMPOSE) exec db mariadb -uroot -p"$$DB_ROOT_PASSWORD" "$$DB_NAME"

clean:
	$(COMPOSE) down --remove-orphans
