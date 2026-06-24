// Config for the generic OAuth2 connector. ONE engine handles many providers —
// each just declares its endpoints + which env vars hold the app credentials.
// No secrets live here; only public endpoint/scope info and env-var NAMES.
//
// A provider "lights up" (real Connect popup) once both its env vars are set in
// Netlify. Until then the dashboard shows the setup instructions.
//
// YouTube is handled by the Google flow (it's a Google scope), not here.
// Special cases NOT in this generic engine (need bespoke flows): Twitter/X (PKCE),
// Shopify (shop-domain), WordPress self-hosted (application passwords).

export interface OAuthProviderConfig {
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  clientIdParam?: string; // some APIs name it differently (e.g. TikTok: client_key)
  clientAuth?: "body" | "basic"; // how the token endpoint wants the client creds
  userInfoUrl?: string;
  userInfoLabelKey?: string;
  extraAuthParams?: Record<string, string>;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  facebook: {
    name: "Facebook Pages",
    authorizeUrl: "https://www.facebook.com/v19.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v19.0/oauth/access_token",
    scope: "pages_show_list,pages_read_engagement,pages_manage_posts",
    clientIdEnv: "FACEBOOK_CLIENT_ID",
    clientSecretEnv: "FACEBOOK_CLIENT_SECRET",
    userInfoUrl: "https://graph.facebook.com/me?fields=name",
    userInfoLabelKey: "name",
  },
  instagram: {
    name: "Instagram",
    authorizeUrl: "https://www.facebook.com/v19.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v19.0/oauth/access_token",
    scope: "instagram_basic,instagram_content_publish,pages_show_list",
    clientIdEnv: "FACEBOOK_CLIENT_ID",
    clientSecretEnv: "FACEBOOK_CLIENT_SECRET",
    userInfoUrl: "https://graph.facebook.com/me?fields=name",
    userInfoLabelKey: "name",
  },
  meta_ads: {
    name: "Meta Ads",
    authorizeUrl: "https://www.facebook.com/v19.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v19.0/oauth/access_token",
    scope: "ads_read,ads_management,business_management",
    clientIdEnv: "FACEBOOK_CLIENT_ID",
    clientSecretEnv: "FACEBOOK_CLIENT_SECRET",
    userInfoUrl: "https://graph.facebook.com/me?fields=name",
    userInfoLabelKey: "name",
  },
  linkedin: {
    name: "LinkedIn",
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scope: "openid profile w_member_social",
    clientIdEnv: "LINKEDIN_CLIENT_ID",
    clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
    userInfoUrl: "https://api.linkedin.com/v2/userinfo",
    userInfoLabelKey: "name",
  },
  reddit: {
    name: "Reddit",
    authorizeUrl: "https://www.reddit.com/api/v1/authorize",
    tokenUrl: "https://www.reddit.com/api/v1/access_token",
    scope: "identity submit",
    clientIdEnv: "REDDIT_CLIENT_ID",
    clientSecretEnv: "REDDIT_CLIENT_SECRET",
    clientAuth: "basic",
    extraAuthParams: { duration: "permanent" },
    userInfoUrl: "https://oauth.reddit.com/api/v1/me",
    userInfoLabelKey: "name",
  },
  pinterest: {
    name: "Pinterest",
    authorizeUrl: "https://www.pinterest.com/oauth/",
    tokenUrl: "https://api.pinterest.com/v5/oauth/token",
    scope: "boards:read,pins:read,pins:write",
    clientIdEnv: "PINTEREST_CLIENT_ID",
    clientSecretEnv: "PINTEREST_CLIENT_SECRET",
    clientAuth: "basic",
  },
  wordpress: {
    name: "WordPress.com",
    authorizeUrl: "https://public-api.wordpress.com/oauth2/authorize",
    tokenUrl: "https://public-api.wordpress.com/oauth2/token",
    scope: "posts media",
    clientIdEnv: "WORDPRESS_CLIENT_ID",
    clientSecretEnv: "WORDPRESS_CLIENT_SECRET",
  },
  tiktok: {
    name: "TikTok",
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    scope: "user.info.basic,video.publish,video.upload",
    clientIdEnv: "TIKTOK_CLIENT_KEY",
    clientSecretEnv: "TIKTOK_CLIENT_SECRET",
    clientIdParam: "client_key",
  },
};

// Providers that exist in the catalog but need a bespoke flow (not the generic one).
export const SPECIAL_PROVIDERS = ["x", "shopify", "wordpress_self", "tiktok_ads", "google_business", "stripe", "notion"];
