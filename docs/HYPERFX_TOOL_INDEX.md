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

## Where this maps into Pydent

- MCP client + envelope parsing: `src/lib/hyperfx.ts`
- Agent bridge (lanes, write-gating, system note): `src/lib/hyperfx-team-tools.ts`
- Meta Ads tab data: `src/app/api/hyperfx/meta/route.ts` (+ `campaign`, `manage`, `adpreview`)
- Recommendations autopilot: `src/lib/ads-autopilot.ts`
- Diagnostics: `/api/hyperfx/diag?ws=<workspace>&deep=1`
