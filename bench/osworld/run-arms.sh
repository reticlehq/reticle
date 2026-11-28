#!/bin/bash
# The OSWorld arms of the computer-realm benchmark, one after another, on test_small with GPT-5.4.
# Run on the OSWorld host, with the operator up: node ~/reticle/bench/osworld/operator.mjs
# Do not run arms in parallel: the guest load pushes Reticle calls past the 8 s bridge limit.
#
#   bench/osworld/run-arms.sh [suffix]
#
# Arms: base (OSWorld's screenshot agent), tree (OSWorld's accessibility tree as one tool),
# reticle with free reads (only acts count as steps), and reticle under OSWorld's rule (every turn
# is a step). Results go to ~/OSWorld/results-<arm><suffix>/.../<domain>/<task>/result.txt.
set -u
S=${1:-}
cd ~/OSWorld || exit 1
A="--provider_name docker --headless --client_password password --model gpt-5.4 --num_envs 1 --max_steps 15 --test_all_meta_path evaluation_examples/test_small.json"
R=~/reticle/bench/osworld/run_reticle.py
.venv/bin/python scripts/python/run_multienv_gpt54.py $A --result_dir "./results-base$S" > ~/arm-base$S.log 2>&1
RETICLE_ARM=tree .venv/bin/python $R gpt54 $A --result_dir "./results-tree$S" > ~/arm-tree$S.log 2>&1
.venv/bin/python $R gpt54 $A --result_dir "./results-reticle-free$S" > ~/arm-reticle-free$S.log 2>&1
RETICLE_FREE_READS=0 .venv/bin/python $R gpt54 $A --result_dir "./results-reticle-strict$S" > ~/arm-reticle-strict$S.log 2>&1
