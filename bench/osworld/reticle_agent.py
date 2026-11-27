"""The Reticle arm of the OSWorld benchmark: an OSWorld agent, plus Reticle's tools.

Each class here is an agent that OSWorld ships, with four more tools. The model, the system
prompt, the screenshot tool, the step count and the evaluator stay OSWorld's own, so the one
difference between the two arms is Reticle. The tools go to the operator (operator.mjs, on the
host), which runs Reticle's computer realm on the guest's applications.

    reticle_apps   the applications that have a window
    reticle_look   the accessibility tree of one application, each element with a ref
    reticle_find   the elements of one application with a role, a name or a text
    reticle_act    an action on one element, with real input; `until_text` proves its result

    ReticleGPT54Agent   mm_agents.gpt54_agent.GPT54Agent (OpenAI GPT-5.4, Responses API)
    ReticleAgent        mm_agents.anthropic.AnthropicAgent (Claude)

One model turn is one step, as for the other arm. A turn with only a Reticle call runs it here and
gives OSWorld a WAIT, so the environment takes its screenshot as after any step.
"""
import json
import logging
import os
import urllib.request

logger = logging.getLogger('desktopenv.agent.reticle')
OPERATOR = os.environ.get('RETICLE_OPERATOR', 'http://127.0.0.1:4498')
RESULT_LIMIT = 15000

APP = {'type': 'string', 'description': 'The application, as reticle_apps names it, e.g. "soffice".'}
TOOLS = [
    {
        'name': 'reticle_apps',
        'description': 'List the applications that have a window, by name.',
        'parameters': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'reticle_look',
        'description': (
            'Read the accessibility tree of one application: every element with its role, name, '
            'value and states, and a ref to act on. It reads what the application says, not pixels. '
            'Web pages in Google Chrome are not in the tree: use the computer tool there.'
        ),
        'parameters': {'type': 'object', 'properties': {'app': APP}, 'required': ['app']},
    },
    {
        'name': 'reticle_find',
        'description': (
            'Find the elements of one application: by role (with an exact name if you give one), '
            'or by part of their text. Cheaper than reticle_look.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'app': APP,
                'role': {'type': 'string', 'description': 'e.g. button, menu, menuitem, textbox, checkbox, cell.'},
                'name': {'type': 'string', 'description': 'With a role: the exact name. Alone: part of the text.'},
            },
            'required': ['app'],
        },
    },
    {
        'name': 'reticle_act',
        'description': (
            'Do one action on one element, by its ref, with the real pointer and keyboard. '
            'Give until_text to prove the result: the answer is verified "yes" only when an element '
            'then shows that text. Then you do not need a screenshot to check it.'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'app': APP,
                'ref': {'type': 'string', 'description': 'The ref from reticle_look or reticle_find, e.g. "e27".'},
                'action': {'type': 'string', 'enum': ['click', 'dblclick', 'rightclick', 'type', 'press', 'fill']},
                'text': {'type': 'string', 'description': 'The text to type or fill, or the key to press, e.g. "Return" or "ctrl+s".'},
                'until_text': {'type': 'string', 'description': 'Text that must show after the action.'},
            },
            'required': ['app', 'ref', 'action'],
        },
    },
]
PROMPT = (
    '\n* You also have Reticle tools. They read the accessibility tree of a native application '
    '(LibreOffice, Thunderbird, VS Code, GIMP, VLC, the file manager): exact names, values and '
    'states, which a screenshot can only guess. Prefer them to read a value or to find a control, '
    'and act on an element by its ref. Give reticle_act an until_text when you know the result to '
    'expect. Use the computer tool for web pages and for what the tree does not show.'
)


def post(path, body=None):
    request = urllib.request.Request(
        OPERATOR + path,
        None if body is None else json.dumps(body).encode(),
        {'content-type': 'application/json'},
    )
    return json.loads(urllib.request.urlopen(request, timeout=300).read())


class Reticle:
    """Reticle's tools for one environment: the operator joins its applications on demand."""

    def __init__(self, env):
        self.env = env
        self.reset()

    def reset(self):
        self.sessions, self.ready, self.calls = {}, False, 0

    def setup(self):
        # At the first call of a task, not at reset: an agent can reset before the guest is up.
        if not self.ready:
            ready = post('/setup', {'guest': self.env.controller.http_server})
            logger.info('reticle setup: %s', ready)
            self.ready = True

    def session(self, app):
        listed = post('/apps').get('apps', [])
        found = next((a for a in listed if a['name'] == app), None) or next(
            (a for a in listed if app.lower() in a['name'].lower()), None)
        if found is None:
            raise ValueError(f'no application "{app}" has a window. Open: {[a["name"] for a in listed]}')
        if found['pid'] not in self.sessions:
            joined = post('/join', {'pid': found['pid'], 'keep': bool(self.sessions)})
            if 'sessionId' not in joined:
                raise ValueError(joined.get('error', 'the join failed'))
            self.sessions[found['pid']] = joined['sessionId']
        return self.sessions[found['pid']]

    def run(self, name, given):
        self.calls += 1
        try:
            self.setup()
            if name == 'reticle_apps':
                answer = [a['name'] for a in post('/apps').get('apps', [])]
            elif name == 'reticle_look':
                read = tool('reticle_snapshot', {'sessionId': self.session(given['app'])})
                answer = read.get('tree', read)
            elif name == 'reticle_find':
                if given.get('role'):
                    query = {'by': 'role', 'value': given['role'], **({'name': given['name']} if given.get('name') else {})}
                else:
                    query = {'by': 'text', 'value': given.get('name', '')}
                answer = tool('reticle_query', {'sessionId': self.session(given['app']), 'limit': 40, **query})
            elif name == 'reticle_act':
                answer = self.act(given)
            else:
                answer = {'error': f'no tool {name}'}
        except Exception as error:  # noqa: BLE001 - the model reads the error and chooses again
            answer = {'error': str(error)}
        text = answer if isinstance(answer, str) else json.dumps(answer)
        logger.info('reticle %s %s -> %s', name, json.dumps(given)[:300], text[:300])
        if len(text) > RESULT_LIMIT:
            text = text[:RESULT_LIMIT] + f'\n[cut at {RESULT_LIMIT} of {len(text)} characters: use reticle_find]'
        return text

    def act(self, given):
        action = given['action']
        args = {'foreground': True}
        if given.get('text') is not None:
            args['value' if action == 'fill' else 'text'] = given['text']
        call = {'sessionId': self.session(given['app']), 'ref': given['ref'], 'action': action, 'args': args}
        if given.get('until_text'):
            call['until'] = {'text': given['until_text']}
            done = tool('reticle_act_and_wait', call)
            return {k: done.get(k) for k in ('verified', 'because', 'verdict', 'error') if done.get(k) is not None}
        done = tool('reticle_act', call)
        return {k: done.get(k) for k in ('ok', 'effect', 'error', 'refused', 'next') if done.get(k) is not None}


def tool(name, args):
    return post('/tool', {'name': name, 'args': args})


def is_reticle(name):
    return str(name or '').startswith('reticle_')


TREE_TOOL = {
    'name': 'read_tree',
    'description': (
        "Read the accessibility tree of the screen, as OSWorld gives it: each element's role, "
        'name, text and position. It reads what the applications say, not pixels.'
    ),
    'parameters': {'type': 'object', 'properties': {}},
}
TREE_PROMPT = (
    '\n* You also have read_tree: the accessibility tree of the screen. Use it to read a value or '
    'to find a control that a screenshot shows badly.'
)


class Tree:
    """The control arm: OSWorld's own accessibility tree as a tool, with no refs, actions or proof.

    A win of the Reticle arm over this arm is what Reticle adds to the tree that any agent can get.
    """

    def __init__(self, env, max_tokens):
        self.env, self.max_tokens = env, max_tokens

    def reset(self):
        pass

    def run(self, _name, _given):
        from mm_agents.agent import linearize_accessibility_tree, trim_accessibility_tree
        raw = self.env.controller.get_accessibility_tree()
        if raw is None:
            return 'the tree could not be read'
        return trim_accessibility_tree(linearize_accessibility_tree(raw, 'ubuntu'), self.max_tokens)


def gpt54_agent():
    from mm_agents.gpt54_agent import GPT54Agent, _get_field

    # RETICLE_ARM=tree gives the control arm (Tree); any other value, Reticle's tools.
    control = os.environ.get('RETICLE_ARM') == 'tree'

    class ReticleGPT54Agent(GPT54Agent):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.reticle = Tree(self.env, self.a11y_tree_max_tokens) if control else Reticle(self.env)
            self.tools = [*self.tools, *({'type': 'function', **t} for t in ([TREE_TOOL] if control else TOOLS))]
            self.last_response = None

        def reset(self, _logger=None):
            super().reset(_logger)
            self.reticle.reset()

        def _create_response(self, request_input, instructions):
            self.last_response = super()._create_response(request_input, instructions + (TREE_PROMPT if control else PROMPT))
            return self.last_response

        def predict(self, instruction, obs):
            info, actions = super().predict(instruction, obs)
            ran = False
            for item in _get_field(self.last_response, 'output', []) or []:
                if _get_field(item, 'type') != 'function_call':
                    continue
                given = json.loads(_get_field(item, 'arguments') or '{}')
                said = self.reticle.run(_get_field(item, 'name'), given)
                self.pending_input_items.append(
                    {'type': 'function_call_output', 'call_id': _get_field(item, 'call_id'), 'output': said})
                info['response'] = (info.get('response') or '') + f'\n[{_get_field(item, "name")}] {said[:500]}'
                ran = True
            if ran and not actions:
                # The run loop ends the task on a turn without an action: a Reticle turn is a step.
                actions = [{'action_space': 'pyautogui', 'action': 'WAIT', 'batch_last': False}]
                info['state_correct'] = not info.get('infeasible_message')
            return info, actions

    return ReticleGPT54Agent


def anthropic_agent():
    import mm_agents.anthropic.main as claude
    from mm_agents.anthropic.main import AnthropicAgent

    def with_reticle_tools(create):
        def call(client, _agent=None, **kwargs):
            if isinstance(_agent, ReticleAgent):
                kwargs['tools'] = [*kwargs.get('tools', []), *(
                    {'name': t['name'], 'description': t['description'], 'input_schema': t['parameters']} for t in TOOLS)]
            return create(client, _agent=_agent, **kwargs)
        return call

    # ponytail: OSWorld names api_fallback_create as the one point for every model call; patch it there.
    claude.api_fallback_create = with_reticle_tools(claude.api_fallback_create)

    class ReticleAgent(AnthropicAgent):
        def __init__(self, *args, **kwargs):
            kwargs['system_prompt_suffix'] = (kwargs.get('system_prompt_suffix') or '') + PROMPT
            super().__init__(*args, **kwargs)
            self.reticle = Reticle(kwargs.get('env'))
            self.answers = {}

        def reset(self, _logger=None, *args, **kwargs):
            super().reset(_logger, *args, **kwargs)
            self.reticle.reset()
            self.answers = {}

        def parse_actions_from_tool_call(self, tool_call):
            return '' if is_reticle(tool_call.get('name')) else super().parse_actions_from_tool_call(tool_call)

        def add_tool_result(self, tool_call_id, result, screenshot=None, extra_screenshots=None):
            said = self.answers.pop(tool_call_id, None)
            super().add_tool_result(tool_call_id, result if said is None else said, screenshot, extra_screenshots)

        def predict(self, task_instruction, obs=None, system=None):
            reasonings, actions = super().predict(task_instruction, obs, system)
            out = []
            for action in actions or []:
                if is_reticle(action.get('name')):
                    # ponytail: a Reticle call runs before the computer calls of the same turn.
                    self.answers[action['id']] = self.reticle.run(action['name'], action.get('input') or {})
                    out.append({'action_type': 'WAIT', 'raw_response': action.get('raw_response')})
                else:
                    out.append(action)
            return reasonings, (out if actions else actions)

    return ReticleAgent
