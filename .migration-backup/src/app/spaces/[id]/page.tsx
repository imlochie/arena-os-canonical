import SpaceDetail from "@/components/SpaceDetail";

export const dynamic = "force-dynamic";

export default async function SpacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SpaceDetail id={id} />;
}
