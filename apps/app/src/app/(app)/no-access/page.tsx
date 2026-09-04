import { Header } from '@/components/header';
import { OrganizationSwitcher } from '@/components/organization-switcher';
import { env } from '@/env.mjs';
import { serverApi } from '@/lib/api-server';
import type { OrganizationFromMe } from '@/types';
import { auth } from '@/utils/auth';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';

// Operative: self-hosted deployments shouldn't point users at portal.trycomp.ai
const portalUrl = env.NEXT_PUBLIC_PORTAL_URL || 'https://portal.trycomp.ai';

interface AuthMeResponse {
  organizations: OrganizationFromMe[];
}

export default async function NoAccess() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session || !session.session.activeOrganizationId) {
    return redirect('/');
  }

  const [meRes, orgRes] = await Promise.all([
    serverApi.get<AuthMeResponse>('/v1/auth/me'),
    serverApi.get<{ id: string; name: string }>('/v1/organization'),
  ]);

  const organizations = meRes.data?.organizations ?? [];
  const currentOrg = orgRes.data ?? null;

  return (
    <div className="flex h-dvh flex-col">
      <Header organizationId={currentOrg?.id} hideChat={true} />
      <div className="bg-foreground/05 flex flex-1 flex-col items-center justify-center gap-4">
        <h1 className="text-2xl font-bold">Access Denied</h1>
        <div className="flex flex-col text-center">
          <p>
            Your current role doesn&apos;t have access to the app. If you&apos;re looking for the employee portal, go to{' '}
            <Link href={portalUrl} className="text-primary underline">
              {portalUrl.replace(/^https?:\/\//, '')}
            </Link>
            .
          </p>
          <p>Please select another organization or contact your organization administrator.</p>
        </div>
        <div>
          <OrganizationSwitcher
            organizations={organizations}
            organization={currentOrg}
          />
        </div>
      </div>
    </div>
  );
}
