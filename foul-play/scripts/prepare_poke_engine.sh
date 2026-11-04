#!/bin/sh
set -eu

engine_root=${1:-../poke-engine}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patch_file="$script_dir/../patches/poke-engine-v0.0.48-evaluator.patch"
source_patch_file="$script_dir/../patches/poke-engine-v0.0.48-evaluator-source.patch"
engine_source_patch_file="$script_dir/../patches/poke-engine-v0.0.48-engine-source-attestation.patch"
version=$(git -C "$engine_root" describe --tags --exact-match)
if [ "$version" != "v0.0.48" ]; then
	printf 'Expected ../poke-engine at tag v0.0.48, found %s\n' "$version" >&2
	exit 2
fi

if ! grep -q 'fn evaluate_state_breakdown' "$engine_root/poke-engine-py/src/lib.rs"; then
	git -C "$engine_root" apply --check "$patch_file"
	git -C "$engine_root" apply "$patch_file"
fi
if ! grep -q 'fn evaluator_source' "$engine_root/poke-engine-py/src/lib.rs"; then
	git -C "$engine_root" apply --check "$source_patch_file"
	git -C "$engine_root" apply "$source_patch_file"
fi
if ! grep -q 'fn engine_source_sha256' "$engine_root/poke-engine-py/src/lib.rs"; then
	git -C "$engine_root" apply --check "$engine_source_patch_file"
	git -C "$engine_root" apply "$engine_source_patch_file"
fi
printf 'poke-engine evaluator instrumentation and complete-source fingerprint are applied.\n'
