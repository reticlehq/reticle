"""Run one of OSWorld's own runners with its agent swapped for the Reticle arm (reticle_agent.py).

Run it from the OSWorld checkout, with the operator (operator.mjs) up. The first argument names
the runner; the rest are that runner's own arguments. Give each arm its own --result_dir: both
arms write under the model's name.

    cd ~/OSWorld && python ~/reticle/bench/osworld/run_reticle.py gpt54 --provider_name docker \\
        --model gpt-5.4 --max_steps 50 --result_dir ./results-reticle \\
        --test_all_meta_path evaluation_examples/test_small.json

bench/osworld/run-arms.sh runs every arm, one after another.
"""
import os
import runpy
import sys

sys.path[:0] = [os.getcwd(), os.path.dirname(os.path.abspath(__file__))]

import reticle_agent  # noqa: E402

RUNNERS = {
    # runner: (its script, the module it imports the agent from, the agent's name, the Reticle arm)
    'gpt54': ('run_multienv_gpt54.py', 'mm_agents.gpt54_agent', 'GPT54Agent', reticle_agent.gpt54_agent),
    'claude': ('run_multienv_claude.py', 'mm_agents.anthropic', 'AnthropicAgent', reticle_agent.anthropic_agent),
}
script, module, name, arm = RUNNERS[sys.argv.pop(1)]
# The runner does `from <module> import <name>`: it gets the Reticle arm.
setattr(__import__(module, fromlist=[name]), name, arm())
runpy.run_path(os.path.join(os.getcwd(), 'scripts/python', script), run_name='__main__')
