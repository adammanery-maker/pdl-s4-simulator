PYTHON ?= .venv/bin/python

docker:
	docker build . -t foul-play:latest --build-arg GEN=$(GEN)

clean_logs:
	rm logs/*

clean_data_cache:
	rm -rf fp/data/pkmn_sets_cache/*
	rm -rf fp/data/smogon_stats_cache/*

test:
	ruff check
	pytest tests

fmt:
	ruff format

lint:
	ruff check --fix

poke_engine: poke_engine_local

# This assumes that the pmariglia/poke-engine repository is in the same directory as foul-play
poke_engine_patch:
	./scripts/prepare_poke_engine.sh ../poke-engine

poke_engine_local: poke_engine_patch
	$(PYTHON) -m pip uninstall -y poke-engine
	$(PYTHON) -m pip install -v --force-reinstall --no-cache-dir ../poke-engine/poke-engine-py --config-settings="build-args=--features poke-engine/terastallization --no-default-features"
	$(PYTHON) -m fp.runtime_contract
