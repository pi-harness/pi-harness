// Explicit-only failure fixture. No tools, filesystem, network or environment access.
/** @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi */
export default function (pi) {
  pi.on('before_agent_start', (event) => {
    if (event.prompt.startsWith('PIH_FAIL_LOGGER_AUDIT_')) {
      throw new Error('PIH_EXPECTED_EXTENSION_FAILURE');
    }
  });
}
