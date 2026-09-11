// Explicit-only synthetic event producer: no network, filesystem, or environment access.
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
/** @typedef {import('@pi-harness/plugin-api').PiTelemetryService} TelemetryService */

export default {
  name: 'verify-telemetry-events',
  inject: ['piTools', 'piTelemetry'],
  /** @param {import('@deepseek-ai/cordis').Context} context */
  apply(context) {
    let used = false;
    context.effect(() => context.piTools.register(defineTool({
      name: 'verify_telemetry_events',
      label: 'Synthetic telemetry verification',
      description: 'Test fixture: send only fixed synthetic local events; no network or file writes. Run once per fixture load.',
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: 'sequential',
      execute(_id, params, signal) {
        return Promise.resolve().then(() => {
          if (signal?.aborted || Object.keys(params).length || used) throw new Error('Fixture cancelled, invalid, or already used');
          const before = context.piTelemetry.snapshot();
          if (before.discarded || before.observed || before.names.length) throw new Error('Fixture requires a clean isolated telemetry service');
          used = true;
          let otherListener = 0;
          const unsubscribe = context.on('pi/telemetry', () => { otherListener += 1; });
          let invalidRejected = false;
          try {
            for (let index = 0; index < 105; index++) context.piTelemetry.send({ name: `AUDIT_EVENT_${index}`, properties: { sentinel: 'AUDIT_PROPERTIES_NOT_RETAINED' } });
            context.emit('pi/telemetry', { name: 'AUDIT_BUS', properties: { sentinel: 'AUDIT_PROPERTIES_NOT_RETAINED' } });
            try { context.piTelemetry.send({ name: '   ' }); } catch { invalidRejected = true; }
            const report = { snapshot: context.piTelemetry.snapshot(), otherListener, invalidRejected };
            return { content: [{ type: 'text', text: JSON.stringify(report) }], details: report };
          } finally { unsubscribe(); }
        });
      },
    })));
  },
};
