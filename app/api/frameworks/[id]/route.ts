import { deleteFramework, getFramework, listFrameworks, publicFramework, updateFramework } from "@/lib/db";
import { validateFrameworkInput } from "@/lib/frameworks";
import { apiError, HttpError, requireApiUser } from "@/lib/user";

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: Context) {
  try {
    const user = await requireApiUser({ mutation: true });
    const { id } = await context.params;
    const existing = await getFramework(user.userId, id);
    if (!existing) throw new HttpError(404, "FRAMEWORK_NOT_FOUND", "没有找到这个梳理框架");
    const input = validateFrameworkInput(await request.json() as Record<string, unknown>);
    const frameworks = await listFrameworks(user.userId);
    if (frameworks.some((item) => item.id !== id
      && item.name.toLocaleLowerCase("zh-CN") === input.name.toLocaleLowerCase("zh-CN"))) {
      throw new HttpError(409, "FRAMEWORK_NAME_EXISTS", "已经有同名框架");
    }
    await updateFramework(user.userId, id, input.name, input.instructions);
    const saved = await getFramework(user.userId, id);
    return Response.json({ framework: saved ? publicFramework(saved) : null });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const user = await requireApiUser({ mutation: true });
    const { id } = await context.params;
    if (!await deleteFramework(user.userId, id)) {
      throw new HttpError(404, "FRAMEWORK_NOT_FOUND", "没有找到这个梳理框架");
    }
    return Response.json({ deleted: true });
  } catch (error) {
    return apiError(error);
  }
}
