/**
 * #1707: an Expo app read as plain HTML and was handed a snippet for an index.html Metro never
 * serves, and the no-session scan never looked at Expo web's port 8081.
 *
 * Expo is wired the way CRA is, a dev-only module imported from the app's own entry, with two
 * differences pinned here: the module only reaches the web bundle (Metro resolves `reticle-dev` to
 * `reticle-dev.web.ts` on web and to an empty `reticle-dev.ts` on iOS and Android), and the token
 * travels as `EXPO_PUBLIC_RETICLE_TOKEN`, the one shape Expo inlines into app code.
 */
import { describe, expect, it } from 'vitest';
import { bridgeWsUrl } from '@reticlehq/core';
import { detect, Framework, type DetectInput } from './detect/detect.js';
import { DEV_SERVER_PORTS, frameworkDevPort } from './detect/dev-server-ports.js';
import {
  EXPO_ENV_PATH,
  EXPO_TOKEN_VAR,
  expoEnvPatch,
  expoImportLine,
  expoImportPatch,
  expoNativeModuleFile,
  expoWebModuleFile,
} from './patch/expo.js';
import { StepTitle } from './plan/connect-steps.js';
import { expoSteps } from './plan/plan-expo.js';
import { StepStatus, type PlanInput, type Step } from './plan/plan.js';
import { runInit, type InitOptions } from './run.js';
import { memoryIo } from './memory-io.test-helpers.js';

const EXPO_PKG = {
  name: 'expo-app',
  main: 'expo-router/entry',
  scripts: { start: 'expo start', web: 'expo start --web' },
  dependencies: {
    expo: '~54.0.0',
    'expo-router': '~6.0.0',
    react: '19.1.0',
    'react-dom': '19.1.0',
    'react-native': '0.81.0',
    'react-native-web': '^0.21.0',
  },
  devDependencies: { typescript: '~5.9.2' },
};

const detectInput = (pkg: DetectInput['pkg']): DetectInput => ({
  pkg,
  configFiles: new Set<string>(),
  lockfiles: new Set(['package-lock.json']),
});

const LAYOUT = `import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import 'react-native-reanimated';

export default function RootLayout() {
  return <Stack />;
}
`;

const planFor = (overrides: Partial<PlanInput> = {}): PlanInput =>
  ({
    detection: detect(detectInput(EXPO_PKG)),
    claudeCli: false,
    mcpExists: false,
    options: { port: 4400, projectId: 'demo' },
    expoEntry: { path: 'app/_layout.tsx', source: LAYOUT },
    expoEnv: null,
    pairingToken: 'tok',
    ...overrides,
  }) as unknown as PlanInput;

const step = (steps: Step[], title: StepTitle): Step | undefined =>
  steps.find((s) => s.title === title);

describe('detecting Expo', () => {
  it('reads the expo dependency as Expo, not plain HTML', () => {
    expect(detect(detectInput(EXPO_PKG)).framework).toBe(Framework.EXPO);
  });

  it('keeps Expo when the app also lists vite for tooling, because Metro serves it', () => {
    const pkg = { ...EXPO_PKG, devDependencies: { ...EXPO_PKG.devDependencies, vite: '^7.0.0' } };
    expect(detect(detectInput(pkg)).framework).toBe(Framework.EXPO);
  });

  it('does not claim a bare React Native app, which has no web build', () => {
    const pkg = { dependencies: { react: '19.1.0', 'react-native': '0.81.0' } };
    expect(detect(detectInput(pkg)).framework).not.toBe(Framework.EXPO);
  });
});

describe("Expo web's port", () => {
  it('is in the no-session scan and is the framework default', () => {
    expect(DEV_SERVER_PORTS.has(8081)).toBe(true);
    expect(frameworkDevPort(Framework.EXPO)).toBe(8081);
  });
});

describe('the Expo plan', () => {
  it('writes the web module, its empty native twin, the token, and the import', () => {
    const steps = expoSteps(planFor());
    const web = step(steps, StepTitle.CONNECT_MODULE);
    const native = step(steps, StepTitle.EXPO_NATIVE_MODULE);
    expect(web?.write?.path).toBe('reticle-dev.web.ts');
    expect(native?.write?.path).toBe('reticle-dev.ts');
    expect(step(steps, StepTitle.PAIRING_TOKEN)?.write).toEqual({
      path: EXPO_ENV_PATH,
      content: `${EXPO_TOKEN_VAR}=tok\nEXPO_PUBLIC_RETICLE_URL=${bridgeWsUrl(4400)}\n`,
    });
    const imported = step(steps, StepTitle.CONNECT_SNIPPET_EXPO);
    expect(imported?.status).toBe(StepStatus.APPLY);
    expect(imported?.write?.content).toContain("import '../reticle-dev';");
  });

  it('writes .js modules in a JavaScript app', () => {
    const steps = expoSteps(
      planFor({ detection: detect(detectInput({ ...EXPO_PKG, devDependencies: {} })) }),
    );
    expect(step(steps, StepTitle.CONNECT_MODULE)?.write?.path).toBe('reticle-dev.web.js');
    expect(step(steps, StepTitle.EXPO_NATIVE_MODULE)?.write?.path).toBe('reticle-dev.js');
  });

  it('imports from App.tsx in an app without expo-router', () => {
    const steps = expoSteps(
      planFor({ expoEntry: { path: 'App.tsx', source: "import { View } from 'react-native';\n" } }),
    );
    expect(step(steps, StepTitle.CONNECT_SNIPPET_EXPO)?.write?.content).toBe(
      "import { View } from 'react-native';\nimport './reticle-dev';\n",
    );
  });

  it('reports an entry that already imports the module as done', () => {
    const steps = expoSteps(
      planFor({
        expoEntry: { path: 'app/_layout.tsx', source: `${LAYOUT}import '../reticle-dev';\n` },
      }),
    );
    expect(step(steps, StepTitle.CONNECT_SNIPPET_EXPO)?.status).toBe(StepStatus.ALREADY);
  });

  it('names the line to add when there is no entry, as a connect step init cannot pass', () => {
    const imported = step(expoSteps(planFor({ expoEntry: null })), StepTitle.CONNECT_SNIPPET_EXPO);
    expect(imported?.status).toBe(StepStatus.MANUAL);
    expect(imported?.detail).toContain("import '../reticle-dev';");
  });

  it('asks for the daemon first when no token has been minted', () => {
    const token = step(expoSteps(planFor({ pairingToken: '' })), StepTitle.PAIRING_TOKEN);
    expect(token?.status).toBe(StepStatus.MANUAL);
  });
});

describe('the modules', () => {
  it('connects only in a development browser, reading EXPO_PUBLIC_ variables with dot access', () => {
    const web = expoWebModuleFile(4400, 'demo', { typescript: true });
    // expo-router renders web pages in Node too, and the SDK must not install itself there.
    expect(web).toContain(
      "if (process.env.NODE_ENV === 'development' && typeof window !== 'undefined') {",
    );
    expect(web).toContain(`process.env.${EXPO_TOKEN_VAR}`);
    expect(web).toContain('process.env.EXPO_PUBLIC_RETICLE_URL');
    expect(web).toContain("import('@reticlehq/react')");
  });

  it('keeps the SDK out of the native twin', () => {
    expect(expoNativeModuleFile(true)).not.toContain('@reticlehq');
    expect(expoNativeModuleFile(true)).toContain('export {};');
    expect(expoNativeModuleFile(false)).not.toContain('export');
  });
});

describe('the import line', () => {
  it('points at the root module from wherever the entry is', () => {
    expect(expoImportLine('App.tsx')).toBe("import './reticle-dev';");
    expect(expoImportLine('app/_layout.tsx')).toBe("import '../reticle-dev';");
    expect(expoImportLine('src/app/_layout.tsx')).toBe("import '../../reticle-dev';");
  });

  it('goes after an import spread over several lines, not inside its braces', () => {
    const source =
      "import {\n  DarkTheme,\n  ThemeProvider,\n} from '@react-navigation/native';\n\nexport default 1;\n";
    expect(expoImportPatch(source, "import '../reticle-dev';")).toBe(
      "import {\n  DarkTheme,\n  ThemeProvider,\n} from '@react-navigation/native';\nimport '../reticle-dev';\n\nexport default 1;\n",
    );
  });

  it('goes at the top of a file with no imports', () => {
    expect(expoImportPatch('export default 1;\n', "import './reticle-dev';")).toBe(
      "import './reticle-dev';\nexport default 1;\n",
    );
  });

  it('keeps CRLF endings working', () => {
    const patched = expoImportPatch(
      "import { Stack } from 'expo-router';\r\nexport default 1;\r\n",
      "import '../reticle-dev';",
    );
    expect(patched).toBe(
      "import { Stack } from 'expo-router';\r\nimport '../reticle-dev';\nexport default 1;\r\n",
    );
  });
});

describe('the env file', () => {
  it('keeps what is already there and replaces a stale token', () => {
    expect(expoEnvPatch(`API=1\n${EXPO_TOKEN_VAR}=old\n`, 'new')).toBe(
      `API=1\n${EXPO_TOKEN_VAR}=new\n`,
    );
  });
});

describe('reticle init on an Expo app', () => {
  const OPTS: InitOptions = {
    cwd: '/app',
    port: undefined,
    mcp: false,
    install: false,
    dryRun: false,
  };

  it('wires the root layout and leaves the native bundle without the SDK', () => {
    const io = memoryIo({
      'package.json': JSON.stringify(EXPO_PKG),
      'tsconfig.json': '{ "extends": "expo/tsconfig.base" }\n',
      'app/_layout.tsx': LAYOUT,
    });
    const result = runInit(OPTS, io);
    expect(result.ok).toBe(true);
    expect(result.manual).toBe(0);
    expect(io.lines.join('\n')).toContain('Connect snippet (Expo) → app/_layout.tsx');
    expect(io.written['app/_layout.tsx']).toContain("import '../reticle-dev';");
    expect(io.written['reticle-dev.web.ts']).toContain("import('@reticlehq/react')");
    expect(io.written['reticle-dev.ts']).not.toContain('@reticlehq');
    expect(io.written[EXPO_ENV_PATH]).toContain(`${EXPO_TOKEN_VAR}=`);
  });
});
