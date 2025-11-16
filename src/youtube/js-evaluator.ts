import { newQuickJSWASMModule } from 'quickjs-emscripten';
import { RELEASE_SYNC } from 'quickjs-emscripten/variants';
import { newVariant } from 'quickjs-emscripten-core';
import wasmModule from '../quickjs.wasm';
import { env } from 'cloudflare:workers';

// Types from youtubei.js PlatformShim
type VMPrimative = string | number | boolean | null | undefined;

interface BuildScriptResult {
   output: string;
   exported: string[];
   exportedRawValues?: Record<string, any>;
}

type EvalResult = {
   [key: string]: any;
} | void;

// Create Cloudflare-specific variant with directly imported WASM
const cloudflareVariant = newVariant(RELEASE_SYNC, { wasmModule });

let quickJSModule: Awaited<ReturnType<typeof newQuickJSWASMModule>> | null = null;

async function getQuickJSModule() {
   if (!quickJSModule) {
      quickJSModule = await newQuickJSWASMModule(cloudflareVariant);
   }
   return quickJSModule;
}

async function evaluateWithQuickJS(data: BuildScriptResult, env: Record<string, VMPrimative>): Promise<EvalResult> {
   const QuickJS = await getQuickJSModule();
   const vm = QuickJS.newContext();

   try {
      // Build the code to execute
      const properties = [];

      if (env.n) {
         properties.push(`n: exportedVars.nFunction("${env.n}")`);
      }

      if (env.sig) {
         properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
      }

      // Wrap the code in an IIFE to allow the return statement
      const code = `(function() {\n${data.output}\nreturn { ${properties.join(', ')} };\n})()`;

      // Evaluate the code
      const result = vm.evalCode(code);

      if (result.error) {
         const error = vm.dump(result.error);
         result.error.dispose();
         throw new Error(`QuickJS evaluation error: ${JSON.stringify(error)}`);
      }

      // Extract the result
      const jsResult = vm.dump(result.value);
      result.value.dispose();

      return jsResult as EvalResult;
   } catch (error) {
      console.error('Error in QuickJS evaluator:', error);
      throw error;
   } finally {
      vm.dispose();
   }
}

function hashScriptOutput(output: string): string {
   let hash = 0;

   for (let i = 0; i < output.length; i++) {
      hash = (hash * 31 + output.charCodeAt(i)) | 0;
   }

   return hash.toString(16);
}

async function evaluateWithWorkerLoader(data: BuildScriptResult, vmEnv: Record<string, VMPrimative>): Promise<EvalResult> {
   // Ensure the binding exists at runtime
   const loader = env.LOADER;

   if (!loader || typeof loader.get !== 'function') {
      throw new Error('Worker Loader binding "LOADER" is not configured on Env.');
   }

   const scriptId = hashScriptOutput(data.output);
   const workerId = `yt-decipher:${scriptId}`;

   const moduleSourceLines = [
      'export default {',
      '  async fetch(request, env, ctx) {',
      '    const { vmEnv } = await request.json();',
      data.output,
      '    const result = {};',
      "    if (vmEnv && typeof vmEnv.n === 'string') {",
      '      // @ts-ignore - populated by the injected script',
      '      result.n = exportedVars.nFunction(vmEnv.n);',
      '    }',
      "    if (vmEnv && typeof vmEnv.sig === 'string') {",
      '      // @ts-ignore - populated by the injected script',
      '      result.sig = exportedVars.sigFunction(vmEnv.sig);',
      '    }',
      '    return new Response(JSON.stringify(result), {',
      '      headers: { "Content-Type": "application/json" }',
      '    });',
      '  }',
      '};',
   ];

   const moduleSource = moduleSourceLines.join('\n');

   const worker = loader.get(workerId, async () => {
      return {
         compatibilityDate: '2025-05-03',
         mainModule: 'sandbox.js',
         modules: {
            'sandbox.js': { js: moduleSource },
         },
         env: {},
         globalOutbound: null,
      };
   });

   const entrypoint = worker.getEntrypoint();

   const response = await entrypoint.fetch('http://sandbox/eval', {
      method: 'POST',
      body: JSON.stringify({ vmEnv }),
   });

   if (!response.ok) {
      throw new Error(`Worker Loader evaluation failed with status ${response.status}`);
   }

   const result = (await response.json()) as EvalResult;

   return result;
}

export async function evaluateJavaScript(data: BuildScriptResult, vmEnv: Record<string, VMPrimative>): Promise<EvalResult> {
   const engine = env.EVAL_ENGINE as string | undefined;

   if (engine === 'loader') {
      try {
         return await evaluateWithWorkerLoader(data, vmEnv);
      } catch (error) {
         console.error('Error in Worker Loader evaluator, falling back to QuickJS:', error);
      }
   }

   return await evaluateWithQuickJS(data, vmEnv);
}
