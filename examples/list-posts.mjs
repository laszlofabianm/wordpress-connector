import {
  WordPressConnector,
  getRequiredEnv,
  readEnvFile,
} from "../dist/index.js";

const env = await readEnvFile();
const wordpress = new WordPressConnector({
  baseUrl: getRequiredEnv(env, "WORDPRESS_BASE_URL"),
  username: getRequiredEnv(env, "WORDPRESS_USERNAME"),
  appPassword: getRequiredEnv(env, "WORDPRESS_APP_PASSWORD"),
});

await wordpress.testConnection();
const posts = await wordpress.listPosts({ perPage: 10, status: "publish" });
console.dir(posts, { depth: null });
