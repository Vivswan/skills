// Claude Code's teammate shutdown, hand-written in its protocol: the request the lead's message puts
// in a teammate's transcript, and the SendMessage input the teammate approves it with.

/** The lead's shutdown request as the teammate's transcript carries it. */
export function shutdownRequest(name: string): string {
  return `<teammate-message teammate_id="team-lead">\n{"type":"shutdown_request","requestId":"shutdown-1@${name}","from":"team-lead","reason":"the work is done"}\n</teammate-message>`;
}

/** The body the teammate answers the request with: an approval ends its process, a decline does not. */
export function shutdownResponse(name: string, approve: boolean): Record<string, unknown> {
  return { type: "shutdown_response", request_id: `shutdown-1@${name}`, approve };
}
