import { createFramework, listFrameworks, publicFramework } from "@/lib/db";
import { SYSTEM_FRAMEWORK, validateFrameworkInput } from "@/lib/frameworks";
import { apiError, HttpError, requireApiUser } from "@/lib/user";

export async function GET() {
  try {
    const user = await requireApiUser();
    const frameworks = await listFrameworks(user.userId);
    return Response.json({
      systemFramework: SYSTEM_FRAMEWORK,
      frameworks: frameworks.map(publicFramework),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireApiUser({ mutation: true });
    const body = await request.json() as Record<string, unknown>;
    const input = validateFrameworkInput(body);
    const frameworks = await listFrameworks(user.userId);
    if (frameworks.length >= 50) {
      throw new HttpError(409, "FRAMEWORK_LIMIT_REACHED", "最多可保存 50 个个性化框架");
    }
    if (frameworks.some((item) => item.name.toLocaleLowerCase("zh-CN") === input.name.toLocaleLowerCase("zh-CN"))) {
      throw new HttpError(409, "FRAMEWORK_NAME_EXISTS", "已经有同名框架");
    }
    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      user_id: user.userId,
      name: input.name,
      instructions: input.instructions,
      created_at: now,
      updated_at: now,
    };
    await createFramework(record);
    return Response.json({ framework: publicFramework(record) }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
