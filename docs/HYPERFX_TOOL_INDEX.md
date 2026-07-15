# Hyperfx engine — tool index (reference)

The marketing engine exposes these tools over MCP. This file is the map of what
exists so code and agents call REAL tool names. Agents discover live
tools/schemas at runtime via `hyperfx_list_tools`; this index is for
maintenance and for wiring new features.

Research pattern (all platforms): drill down the hierarchy, never guess IDs.

```
Account
 └── Campaigns        (search/list campaigns)
      └── Ad Sets      (get_ad_sets / list_ad_groups)
           └── Ads     (get_ads → get_ad_details)
                └── Creatives (get_ad_creative / get_ad_previews)
Performance at any level → *_ad_insights / *_performance
```

Insights responses arrive as an envelope:
`{ object_info, summary_metrics, detailed_insights: [...], insights_count, performance_analysis, account_analysis }`
— per-row data in `detailed_insights`, totals in `summary_metrics`
(`total_spend`, `total_impressions`, …). `src/lib/hyperfx.ts` (`hfxRows`,
`hfxFlatRow`, `hfxMetric`) handles this.

## Meta Business (`meta_business_*`) — 56 tools

- **Account & health**: `list_ad_accounts`, `get_account_info`, `get_meta_accounts`, `run_health_check`, `get_health_check`
  - Meta's API returns NULL `recommendations`/`issues_info` on campaign details for most accounts (Ads-Manager-UI-only alerts). Account alerts come from the health-check pair; performance-derived recommendations are computed in `/api/hyperfx/meta` (`smartRecommendations`).
- **Campaigns**: `search_campaigns`, `create_campaign`, `get_campaign_details`, `update_campaign`, `activate_campaign` (activates campaign + ad sets + ads), `delete_campaign`
- **Ad sets**: `get_ad_sets`, `get_adset_details`, `create_ad_set` (Advantage+ or Manual), `update_ad_set`, `delete_ad_set`
- **Ads**: `get_ads`, `get_ad_details`, `create_ad`, `update_ad`, `delete_ad`
- **Creatives**: `list_ad_creatives`, `get_ad_creative`, `create_ad_creative`, `update_ad_creative`, `delete_ad_creative`, `get_ad_previews`
- **Images/videos**: `list_ad_images`, `get_ad_image`, `upload_ad_image`, `delete_ad_image`, `list_ad_videos`, `upload_ad_video`, `delete_ad_video`
- **Insights**: `ad_insights` (any object: `object_type` account|campaign|adset|ad; `date_preset` or `time_range{since,until}`; `level`, `time_increment`, `include_actions`) — the `maximum` preset is IGNORED; send an explicit ~35-month `time_range` instead (Meta caps lookback at 37 months)
- **Targeting**: `targeting_search` (interests/geo/demo/locales/jobs), `build_placement_spec`, `build_placement_asset_feed_spec`, `list_custom_audiences`, `list_lookalike_audiences`
- **Pixels/tracking**: `list_ad_pixels`, `get_ad_pixel`, `list_tracking_assets`, `list_dataset_conversions`, `upload_offline_events`
- **Pages & IG**: `list_owned_pages`, `search_pages`, `list_instagram_accounts`, `list_lead_forms`
- **Blueprint** (full-funnel builder): `preview_blueprint` (validate), `create_from_blueprint` (campaign + ad sets + ads in one call) — candidate upgrade for the campaign-strategy wizard

Result action types seen live: `onsite_conversion.total_messaging_connection`
(WhatsApp conversations — the main dental result), `onsite_conversion.messaging_conversation_started_7d`,
`lead`, `link_click`, `post_engagement`. Budgets are in CENTS.

## Google Ads (`google_ads_*`)

- **Accounts**: `list_accounts`, `get_account`, `list_manager_accounts`
- **Campaigns**: `list_campaigns`, `get_campaign`, `create_campaign`, `update_campaign`, `enable_campaign`, `pause_campaign`, `remove_campaign`
- **Ad groups**: `list_ad_groups`, `get_ad_group`, `create_ad_group`, `update_ad_group`, `pause_ad_group`, `remove_ad_group`
- **Ads**: `list_ads`, `get_ad`, `create_responsive_search_ad`, `create_responsive_display_ad`, `update_ad`, `pause_ad`, `remove_ad`
- **Keywords**: `list_keywords`, `add_keywords`, `update_keyword`, `remove_keyword`, `keyword_ideas`
- **Budgets/bidding**: `list_campaign_budgets`, `create_campaign_budget`, `update_campaign_budget`, `list_bidding_strategies`, `create_bidding_strategy`
- **Audiences/geo**: `list_audiences`, `add_audience_to_ad_group`, `list_geo_targets`, `add_geo_target`
- **Reporting**: `get_campaign_performance`, `get_ad_group_performance`, `get_keyword_performance`, `get_ad_performance`, `get_search_terms_report`, `get_account_performance`, `query` (custom GAQL)
- **Conversions**: `list_conversion_actions`, `create_conversion_action`, `upload_offline_conversions`

## Google Analytics GA4 (`google_analytics_*`)

- **Accounts**: `list_accounts`, `list_properties`, `get_property`
- **Reporting**: `run_report`, `run_realtime_report`, `run_funnel_report`, `run_pivot_report`, `batch_run_reports`
- **Events**: `list_events`, `list_conversions`, `create_conversion_event`
- **Audiences**: `list_audiences`, `create_audience`, `list_dimensions_metrics`

## Google Search Console (`google_search_console_*`)

- **Sites**: `list_sites`, `get_site`, `add_site`, `delete_site`
- **Search analytics**: `query_search_analytics` (clicks/impressions/CTR/position), `list_sitemaps`, `get_sitemap`, `submit_sitemap`, `delete_sitemap`
- **Indexing**: `inspect_url`, `submit_url`

## Instagram (`instagram_*`)

- **Profile**: `get_user_profile`, `get_profile_by_username`, `get_account_insights`
- **Publishing**: `create_image_post`, `create_video_post`, `create_carousel_post`, `create_story`, `schedule_post`
- **Media**: `list_media`, `get_media`, `delete_media`, `get_media_insights`
- **Comments**: `list_comments`, `reply_to_comment`, `delete_comment`, `hide_comment`, `like_comment`
- **Messaging**: `send_message`, `list_conversations`, `get_conversation`
- **Stories**: `list_stories`, `get_tagged_media`, `get_mentions`

## WordPress (`wordpress_*`) — .com and self-hosted (.org uses Application Passwords)

- **Posts**: `list_posts`, `get_post`, `create_post`, `update_post`, `delete_post`
- **Pages**: `list_pages`, `get_page`, `create_page`, `update_page`, `delete_page`
- **Media**: `list_media`, `upload_media`, `delete_media`
- **Taxonomy**: `list_categories`, `create_category`, `list_tags`, `create_tag`
- **Comments/sites**: `list_comments`, `approve_comment`, `delete_comment`, `list_sites`

## Additional platforms (same list → get → details pattern)

- **GitHub** (`github_*`): repos (`list_repos`, `get_repo`, `create_repo`, `fork_repo`), branches (`list/get/create/delete/merge_branch`), files (`get_file_contents`, `create_or_update_file`, `list_directory`, `search_code`), issues (`list/get/create/update/close_issue`, comments), PRs (`list/get/create/merge_pull_request`, comments, reviews), users/orgs
- **Gmail** (`gmail_*`): read (`list_emails`, `get_email`, `search_emails`, threads), send (`send_email`, `reply_to_email`, `forward_email`, drafts CRUD + `send_draft`), manage (archive/delete/read/unread, labels CRUD), attachments (`list_attachments`, `get_attachment`)
- **Google Calendar** (`google_calendar_*`): calendars CRUD, events (`list/get/create/update/delete/move/search_events`), availability (`get_freebusy`, ACL)
- **Google Docs** (`google_docs_*`): documents CRUD + copy, editing (`insert_text`, `replace_text`, `insert_table`, `insert_image`, `append_text`, `batch_update`), `export_document` (PDF/Word/HTML), `share_document`
- **Google Sheets** (`google_sheets_*`): spreadsheets CRUD + copy, tabs (`list/add/delete/rename_sheet`), data (`get_values`, `update_values`, `append_values`, `clear_values`, batch variants), formatting (`format_cells`, conditional)
- **HubSpot** (`hubspot_*`): contacts/companies/deals CRUD + search + merge, associations (`associate_objects`, `list_associations`), engagements (`create_note/task/meeting/call`, `list_engagements`), tickets + pipelines (`list_pipelines`, `list_pipeline_stages`), properties
- **Google Tag Manager** (`gtm_*`): accounts/containers CRUD, workspaces (+ `get_workspace_status`), tags/triggers/variables CRUD, versions (`create_version`, `publish_version`, environments)
- **Notion** (`notion_*`): `search`, pages (get/create/update/archive), databases (list/get/create/update/`query_database`), blocks (`get_block_children`, `append_block_children`, update/delete), comments
- **Shopify** (`shopify_*`): products + variants CRUD, orders (list/get/create/update/cancel/refund/fulfill), customers CRUD + search, inventory (`get_inventory_level`, `update_inventory_level`, locations), collections + metafields, discounts (`price_rules`, `discount_codes`)
- **TikTok organic** (`tiktok_*`): profile (`get_user_info`, followers), content (`list_videos`, `get_video`, `upload_video`, comments), analytics (`get_video_insights`, `get_account_insights`)
- **TikTok Marketing** (`tiktok_marketing_*`): accounts (+ `get_balance`), campaigns/ad groups/ads CRUD, `upload_image`/`upload_video`, reporting (`get_reports`, `get_audience_insights`), targeting (`search_interests`, `list_locations`)
- **X / Twitter** (`x_*`): tweets (`post_tweet`, `get_tweet`, `search_tweets`, like/retweet/quote/reply, `get_tweet_replies`), users (profiles, follow, followers/following, block/mute), lists + `get_timelines`, DMs (`send_dm`, conversations)
- **Snapchat Ads** (`snapchat_*`): organizations/ad accounts/funding, campaigns CRUD, ad squads CRUD, ads + creatives (+ `upload_media`), audiences + targeting (`search_interests`, `list_locations`), stats (`get_campaign_stats`, `get_ad_squad_stats`, `get_ad_stats`)
- **Stripe** (`stripe_*`): customers CRUD + search, products/prices, subscriptions (create/update/cancel/pause), payments (`payment_intents`, charges, refunds), invoices (create/send/void), `create_payment_link`, coupons, `get_balance`, `calculate_mrr`
- **Amazon Ads** (`amazon_ads_*`): profiles, SP campaigns/ad groups CRUD, keywords (+ `get_keyword_suggestions`), product ads, reporting (`request_report` → `get_report`, `get_campaign_metrics`, `get_keyword_metrics`)
- **Calendly** (`calendly_*`): event types, scheduled events (list/get/cancel), invitees, availability (`get_user_availability`), `create_single_use_link`, webhooks, user/org info
- **LinkedIn organic** (`linkedin_*`): profile, posts (create/list/get/delete, image/video posts, `share_url`), engagement (like/comment/list comments), connections
- **Outlook mail** (`outlook_*`): read (list/get/search messages, folders), send (send/reply/forward, drafts), manage (move/delete/mark read, folders), attachments, contacts CRUD
- **Outlook Calendar** (`outlook_calendar_*`): calendars, events CRUD + accept/decline + search, availability (`get_schedule`, `find_meeting_times`)
- **Microsoft Teams** (`teams_*`): teams/channels CRUD, messages (send/reply/list, chat messages), chats + members, shifts, activity feed
- **LinkedIn Ads** (`linkedin_ads_*`): ad accounts (+ `get_account_report`), campaigns CRUD + search + `get_campaign_report`, creatives CRUD
- **Reddit Ads** (`reddit_ads_*`): businesses/ad accounts/funding, campaigns/ad groups/ads CRUD, promoted posts, audiences + pixels + `get_targeting`, reports per level + `forecast`

Agent access: lanes in `HFX_LANES` (Helena = all ads + social + commerce, Sam =
SEO/content/docs/GTM, Kai = reputation/comments, Angela = CRM/email/calendar/
sheets + Stripe read). Writes are whitelisted per agent in `AGENT_WRITE_TOOLS`
and always confirmation-gated in chat; deletes are never exposed to agents.
Unknown toolkits self-enable via catalog lookup (`resolveToolkitFromCatalog`).

Deliberate scope choices:
- **Agent ad WRITES are Meta-only.** Every ads platform (TikTok, Snapchat,
  Reddit, Amazon, LinkedIn) is fully READ + reporting through the agents, but
  creating/launching live campaigns via chat is enabled only for Meta (which
  has the review-and-confirm wizard UI). Add other platforms to
  `AGENT_WRITE_TOOLS.helena` when each gets its own review surface.
- **Stripe is READ-only** for agents (customers, invoices, balance, MRR) —
  payments remain a future rail, so no charge/refund/invoice-create via chat.
- **GitHub is intentionally unassigned** to any chat agent (no clinic workflow
  uses it) and hidden from the Apps grid; it stays in the auto-enable map so it
  works if ever called directly.

"Connected" is per-clinic on the Hyperfx portal. Settings → Apps reads the live
catalog (`discover_toolkits`) and shows each platform's real connected status;
newly connected platforms beyond the curated list appear automatically.

## Native (always-on) engine tools — no account connection needed

Hyperfx ships ~67 built-in tools that work without connecting any external
platform. Pydent exposes the safe, on-purpose ones to the agents; the rest stay
available to the engine itself but are intentionally NOT handed to chat agents.

Exposed to agents (`NATIVE_READ_TOOLS` / `NATIVE_IMAGE_TOOLS` in
`hyperfx-team-tools.ts`):
- **web_search** — live web search; multiple queries, date/domain/category
  filters (news, research, financial, github, company). All agents.
- **web_fetch_page** — read any URL's full text. All agents.
- **transcribe_video** — audio/video file → text. All agents.
- **Image generation (Helena)** — `generate_image` (auto-picks backend),
  `nano_banana_image_generation`/`_edit`/`_multi_turn` (Gemini "nano", 4K, text
  rendering), `seedream_image_generation` (photoreal product), `openai_image_*`,
  `create_product_photoshoot`, `create_marketplace_cards`. `src/lib/image-gen.ts`
  calls the native generators FIRST (generate_image → nano_banana → seedream →
  openai), then falls back to an image toolkit.

Deliberately NOT exposed to chat agents (available to the engine directly, e.g.
when the user talks to Hyperfx): `shell`, `python`, `javascript`, `sandbox_*`
(arbitrary code / VM), `browser_*` incl. `browser_execute_code` (full remote
browser control), file writes/deletes (`create_file`, `edit_file`,
`delete_file`, `move_files`), and the Hyper Database / dashboard builders. These
are powerful but too broad and off-task for a confirmation-gated clinic chat
agent, and some (shell/python/browser control) are a security surface. Revisit
per-tool if a concrete workflow needs one.

Other native categories (engine-side): full file reading (`read_file`, all
formats incl. PDF OCR, images via vision, docx/xlsx/pptx/eml), planning
(`create_plan`, `todo_write`), memory (`search_thread_history`), and the skills
system (the engine reads a skill before a complex task). Pydent's agents follow
the research hierarchy above rather than the engine's skill files.

## Where this maps into Pydent

- MCP client + envelope parsing: `src/lib/hyperfx.ts`
- Agent bridge (lanes, write-gating, system note): `src/lib/hyperfx-team-tools.ts`
- Meta Ads tab data: `src/app/api/hyperfx/meta/route.ts` (+ `campaign`, `manage`, `adpreview`)
- Recommendations autopilot: `src/lib/ads-autopilot.ts`
- Diagnostics: `/api/hyperfx/diag?ws=<workspace>&deep=1`
