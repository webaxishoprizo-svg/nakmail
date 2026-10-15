import type { ConfigDO } from "../durableObject/config";
import type { Env } from "../types";

export function configStore(env: Env): DurableObjectStub<ConfigDO> {
	const namespace = env.CONFIG;
	return namespace.get(namespace.idFromName("global-config"));
}
