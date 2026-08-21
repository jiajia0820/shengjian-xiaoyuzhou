import { listEpisodes, publicEpisode } from "@/lib/db";
import { apiError, requireApiUser } from "@/lib/user";

export async function GET() {
  try {
    const user = await requireApiUser();
    const episodes = await listEpisodes(user.userId);
    return Response.json({ episodes: episodes.map(publicEpisode) });
  } catch (error) {
    return apiError(error);
  }
}
