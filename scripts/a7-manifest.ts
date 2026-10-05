// Pydent A7 mutation-step manifest — APPROVED STEP DEFINITIONS, HASH-PINNED.
//
// Generated from the migration files at commit 9e7be70 (A7-approved state) and
// reviewed as part of the A7 validation gate. Every file listed here is pinned
// to the SHA-256 of its approved content: the runner refuses a step if any
// file is missing, any hash differs, any unknown .sql file appears in
// supabase/migrations, any numeric prefix is duplicated, or the on-disk order
// differs from this manifest. Changing a migration therefore requires a new
// reviewed manifest, never a silent re-pin.
//
// Step boundaries (operator-approved):
//   baseline-0001-0064 - the A7 baseline. EXCLUDES 0065 and 0066.
//   apply-0065         - Central Knowledge Base schema, alone.
//   apply-0066         - clinic scheduling (renumbered from duplicate 0061), alone,
//                        sequenced after 0065 by operator decision.

export type A7ManifestEntry = { readonly file: string; readonly sha256: string };

export const A7_STEPS = {
  "baseline-0001-0064": {
    description: "Apply baseline migrations 0001-0064 (excludes 0065 and 0066)",
    migrations: [
    { file: "0001_init.sql", sha256: "74c522a05c73b94c0be04bdc780d55e029fe247bdc3c1ba486ab6141bf1ff3e5" },
    { file: "0002_agents.sql", sha256: "be6c3cc3b38aa349b4a7f82e2962e1d4b71d17745a1d14c5f7947f38e4c137f5" },
    { file: "0003_agent_hub.sql", sha256: "6063e2f7ccf254a46a307fa20280b7414457fdd8cc409a968d67567e5eb72fed" },
    { file: "0004_folders_templates.sql", sha256: "3e77097bb3b579e067a5d8c3efcf64af3b6212ab471e8769581108d525858f05" },
    { file: "0005_workflows.sql", sha256: "340a3d88930ddc97cce7f9a1d7f4296bdc301a3d5a867e822a88ae15b55d0398" },
    { file: "0006_clinical_modules.sql", sha256: "b00768b57883730d8f50460e295236b51b5b53730492358aaee6e84bc2d461ae" },
    { file: "0007_whatsapp_config.sql", sha256: "e7baa01f5c4f136e2e2b6be0a8f700cf71f9d8d9f7491d8755225c818f2f059c" },
    { file: "0008_wa_inbox.sql", sha256: "81251160608c7b2afadbd2d8b1a23bdaf5715e27ba1ef17069b315be85ef0dd8" },
    { file: "0009_wa_webhook_log.sql", sha256: "1cd5e56d9c81d0071d2ebedf21781735dfd36ccecf6741bc4b1b7d505575f4e3" },
    { file: "0010_wa_link_patient.sql", sha256: "aec388a11cc1406152453cf9788727356ecc4a6e010ddc3c5a4be45aaca27390" },
    { file: "0011_wa_broadcasts.sql", sha256: "9646776b1e28c610fdb5621146e18f87c2a1e7734da5804fac6a229fed1fa85f" },
    { file: "0012_meta_channels.sql", sha256: "e6d133e02fc7d371d95f58d3e89f29d6d18980342483ad96c484e185c8098a0b" },
    { file: "0013_remove_demo_seed.sql", sha256: "79fb1557a5ac97f9f388c2d130eec48a4c4ee9d86194da4e0d8cbee634a05122" },
    { file: "0014_multi_tenant.sql", sha256: "dffc5033ef0423ecb4c0a041f797b5e362aa12321826a6d247ba6fe5e7f3918e" },
    { file: "0015_opendental_config.sql", sha256: "58d366dd78e645c900dd5c8cbf0610ac5822560630379e2e5ad9477c5143f082" },
    { file: "0016_appointment_external_id.sql", sha256: "74ec7341f528447813b4f7326fab3cf5a8b8a18c766c6fb5208b5b0ef89a56f3" },
    { file: "0017_agent_behavior.sql", sha256: "6b136ddddd416996dc39c29386b3dd523e493992d677652b8a540b9951fcc1d0" },
    { file: "0018_wa_message_dedupe.sql", sha256: "2f83fcff7e21028669134526fdc7cdb80e1620e385ccb593006275285e8342d8" },
    { file: "0019_voice_calls.sql", sha256: "35f1cfc114f372a8a5dc9bef9f523f4e6befe9dfeced7491f1c915e0ab76e134" },
    { file: "0020_catchup.sql", sha256: "3189a7650fd8c29f5c60d89397b974fcabc5460bb3a3a3c346c65e2c47cd9c49" },
    { file: "0021_full_setup_idempotent.sql", sha256: "68fe4b30f708d22c0efe2c76aef2a352561f620aa389df65cd7f4a9d762f0fff" },
    { file: "0022_add_missing_tables.sql", sha256: "659c53cd75e768ad226888073896f941d48a11e171bf6c021894c5a9dab524be" },
    { file: "0023_team_members.sql", sha256: "e1a98ab0c15d844a65333dc7bbcda4c5921ad07f898c68902b46f86f4533ead5" },
    { file: "0024_voices.sql", sha256: "12fd0feb238b1d331af416401740a08aec0b46cbacd4467129b133588e941e3f" },
    { file: "0025_clinic_settings.sql", sha256: "ceee98f12d43f4b190999a48a069046e69bc178dd15ee17cb50430837eb94a84" },
    { file: "0026_connections.sql", sha256: "0f463952829ed833b6c62fe7e3a7fad7b2f1a6be0e8123301658586d1253a576" },
    { file: "0027_sample_data_flag.sql", sha256: "aca2d8ba0427f5dae518a531aececc64e948c502001e0236911a1f668a26ceb5" },
    { file: "0028_connection_access_mode.sql", sha256: "6458adffba00641496fee6f0102cabcc7d953371416a9874c2fcdcffa6f667e4" },
    { file: "0029_learning_questions.sql", sha256: "8ebbb6a902b431157f4f549cd0f897882e9038f6aef948a0badcbd8d22248760" },
    { file: "0030_team_chats_brand.sql", sha256: "0aef32c92a69182bef8cf27f2aef8330bae1b30888f76c93a1b90da8f2bcd3df" },
    { file: "0031_reports_activity.sql", sha256: "3dd204810d0c6ddb9cf29114ee5fe10f6647ff91e560a1ff82e688a64806b57a" },
    { file: "0032_scheduled_tasks.sql", sha256: "01382191a920d280626807bf5f62b86076aa401fab94c51b783e1a53c9185a3d" },
    { file: "0033_brand_documents.sql", sha256: "a08d137d6dbf6a4ce3447e55e748824d94b7b5450a6f1de0ee34d9cfc8ad4658" },
    { file: "0034_voice_numbers.sql", sha256: "4d657b09c4f15d62b82deac0934179f64581779fec9f059794f5716d082c15e0" },
    { file: "0035_voice_settings.sql", sha256: "c151cb5d271fd7052ff93c3716414e2bc56f3e392019553dece7e26f79f1953c" },
    { file: "0036_appointment_booking_meta.sql", sha256: "d39fb0c0670235d6f8fc5c4624c42f099a20ff93106248592328b6c1bb334ca9" },
    { file: "0037_agent_identity.sql", sha256: "cd83aeb15fc468cf4b5df2a13656e85e53d746c076845d0d74bd5e0c64d443b9" },
    { file: "0038_voice_call_detail.sql", sha256: "d4c68de64df028ea6628890628544b93055627e27f31c7567b17b6c632811293" },
    { file: "0039_campaigns.sql", sha256: "a1c7042dbe87f8492eadae22dc6345d156e0f7a619e224fcaf40a4f763ee63d8" },
    { file: "0040_workflow_runs.sql", sha256: "af7fe7a09583ffe0c323e20a16ef3e95b22194d3edc713706fec2579de62bc35" },
    { file: "0041_billing.sql", sha256: "791ff6572c1aacfdc783b5d28699f0beb826f2ba9c6e02988f0ea4fa4d60e186" },
    { file: "0042_clinic_timezone.sql", sha256: "e933ac3f55b5b391b129006258929204dab4825f8d4bc22b555e9d4778abd465" },
    { file: "0043_voice_number_vapi_id.sql", sha256: "6b287d659d4ddbc02fae43e1e608c72b8e53e18dd7b55f54bef46e0d7c9fc409" },
    { file: "0044_oauth_meta_and_workflow_schedule.sql", sha256: "50b3251fd46ccd2a7baee5702bea9e98bb25f0d6e50ff988a15094d5307d08ca" },
    { file: "0045_ig_publish.sql", sha256: "57e6aabf77dc8b7fe667e6894f55edbd3eba0431e438edcdb8e136bc1247a1a5" },
    { file: "0046_clinic_display_name.sql", sha256: "d27ff97ebbe353263f814e50d4073748e3c8b5f90277b767a284c55967353ebd" },
    { file: "0047_clinic_tags.sql", sha256: "98380836cc8c4e60489a2a1dca857d49bc818e55789ffadf20fe5f25d7ffecfe" },
    { file: "0048_message_broadcasts.sql", sha256: "3392be0ab8689afda3598b79da8e875950a61a68fe7ec74255202b65f0991fbe" },
    { file: "0049_pipeline_deals.sql", sha256: "36d052d41b49c2c0b926e72cd8282457c1b46ee91cec96673247e854b908dc01" },
    { file: "0050_workspace_rls.sql", sha256: "f49e49b3f3caddba27c707751f88aee485e4723d395af1aa4bf86e366c284a75" },
    { file: "0051_opendental_credentials.sql", sha256: "49ca046c960dfddd3c996bcd5f1f37e43dee6c60cd9f94efd22b60410b035600" },
    { file: "0052_hyperfx_config.sql", sha256: "c03c388eec5d0a4808d3c98eea0385810883edb27f325b9549fe8910e357291b" },
    { file: "0053_ads_autopilot.sql", sha256: "ecc6822a13b2a802fcb3b2cbfaef2b2e68a724dbc4d80a0e60ee00728413eed3" },
    { file: "0054_brand_identity.sql", sha256: "cc5af9ce94c78310e36d216e829509c2edeb25f8abd250ecbd07b5e6039d555f" },
    { file: "0055_content_calendar.sql", sha256: "2fdd0b1c6893aa217f63a09a3d4de8201e40901f24325161c5c39fdbbb7c12a6" },
    { file: "0056_opendental_developer_key.sql", sha256: "9a7e3bc0ccd586d0f4df5164c2f1b8acb3599fb47ecb0fd2553b976b431a009d" },
    { file: "0057_agents_xai_id.sql", sha256: "d6867c3e828ad5202051276b79635097100cd70b828de8999e3edc441fdb5795" },
    { file: "0058_workspaces_multi.sql", sha256: "2d1e74262d4362de6642d7f2a421f63663f510334553da3af67db5b73d0f99a6" },
    { file: "0059_livekit_config.sql", sha256: "5840f7b824e1bb9bea45f2444fc7f4574c5b58481f51941f426f8daccb0e9360" },
    { file: "0060_livekit_worker_token.sql", sha256: "103f9a7e7da32e709b37ecc41ee35d81837c76b70ff1452f5e83a369d716c80d" },
    { file: "0061_agent_advanced_config.sql", sha256: "e28098f213bc474a1a2f52940f32641308fadb6866f4f89e20857c5882810d10" },
    { file: "0062_staff_call_outcome.sql", sha256: "be482ec900e9881629d3b0a6e2eadcd4cd71709e61765029e7d0f562ef364b0d" },
    { file: "0063_call_recording.sql", sha256: "4c3120e98ff3bac871a6b6b5bb0b4f904a26ebcb4a8b4ae2f7bec55154da55e3" },
    { file: "0064_voice_number_routing.sql", sha256: "71b134c4cf658327088813efdf926e7b3ec57f5a1a57f411e13b87ad86e9c067" },
    ],
  },
  "apply-0065": {
    description: "Apply 0065_central_knowledge.sql (Central KB Phase A schema)",
    migrations: [
    { file: "0065_central_knowledge.sql", sha256: "7976604d40146bd3dbf1b0db0a645ff3c06e3e9209b9651a92b2411a11196263" },
    ],
  },
  "apply-0066": {
    description: "Apply 0066_clinic_scheduling.sql (after 0065, by separate approval)",
    migrations: [
    { file: "0066_clinic_scheduling.sql", sha256: "b230f3e13b50813059b43f433964d93c48282fcf8f62ef022f1a01b956341609" },
    ],
  },
} as const;

export type A7StepId = keyof typeof A7_STEPS;
