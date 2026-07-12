export const dynamic = 'force-dynamic';

export async function GET() {
  return new Response(JSON.stringify({ status: 'ok' }), {
    headers: { 'content-type': 'application/json' },
  });
}
