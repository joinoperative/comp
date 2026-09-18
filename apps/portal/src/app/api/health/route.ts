// Operative: cheap liveness/startup probe for Cloud Run. The portal has no
// other unauthenticated route; `/` renders authenticated layouts and calls
// the API before redirecting, which makes it a poor probe.
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok' });
}
