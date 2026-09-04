import { getApiBaseUrl } from '@/lib/api-server';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const memberId = request.nextUrl.searchParams.get('memberId');
  const exportAll = request.nextUrl.searchParams.get('all') === 'true';

  // Operative: shared with apps/app/src/lib/api-server.ts so this also honours BACKEND_API_URL
  const apiUrl = getApiBaseUrl();

  const cookieHeader = request.headers.get('cookie') ?? '';
  const authorizationHeader = request.headers.get('authorization');

  const endpoint = exportAll
    ? `${apiUrl}/v1/offboarding-checklist/export-all`
    : memberId
      ? `${apiUrl}/v1/offboarding-checklist/member/${encodeURIComponent(memberId)}/export`
      : null;

  if (!endpoint) {
    return NextResponse.json({ error: 'memberId or all=true required' }, { status: 400 });
  }

  let response: Response;
  try {
    const forwardHeaders: Record<string, string> = { cookie: cookieHeader };
    if (authorizationHeader) {
      forwardHeaders.authorization = authorizationHeader;
    }
    response = await fetch(endpoint, {
      headers: forwardHeaders,
    });
  } catch {
    return NextResponse.json({ error: 'Export service unavailable' }, { status: 502 });
  }

  if (!response.ok) {
    return NextResponse.json(
      { error: 'Export failed' },
      { status: response.status },
    );
  }

  const headers = new Headers();
  headers.set('Content-Type', 'application/zip');
  headers.set(
    'Content-Disposition',
    response.headers.get('Content-Disposition') ??
      'attachment; filename="offboarding-export.zip"',
  );

  return new NextResponse(response.body, { headers });
}
