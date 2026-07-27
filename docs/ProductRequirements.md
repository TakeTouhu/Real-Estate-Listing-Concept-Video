# Product Requirements

Version: 1.0
Status: Draft

## Service goal

Enable real-estate companies to create promotional interior walkthrough-style videos from property photos without professional video-editing skills.

## Core users

- Organization Owner: billing, users, brand, all projects
- Admin: users, templates, limits
- Creator: properties, uploads, generation, downloads
- Reviewer: preview, comments, approval, rejection

## Core flow

1. Register a property.
2. Upload 3–20 interior photos.
3. AI evaluates quality and classifies room type.
4. User confirms or edits labels and order.
5. User selects duration, aspect ratio, resolution, camera motion, style, prompt, and negative prompt.
6. System estimates credits and completion time.
7. User starts generation.
8. System creates scene clips asynchronously through WaveSpeedAI.
9. System composes the final video.
10. User reviews, approves, regenerates, or downloads.

## Customization

- Duration: 10–90 seconds, limited by active provider capability
- Aspect ratio: 16:9, 9:16, 1:1 where supported
- Resolution: 720p / 1080p where supported
- Camera motion: slow forward, pan, dolly, room transition
- Style: natural, bright, luxury, calm, family
- Prompt and negative prompt
- BGM, captions, logo, watermark
- AI-generated disclosure

## Room classification

Living room, dining room, kitchen, bedroom, child room, study, bathroom, washroom, toilet, entrance, hallway, balcony, storage, exterior, other. Users can correct AI results.

## Quality and safety checks

Detect low resolution, blur, exposure problems, duplicates, people, personal information, suspicious watermark/copyright, unsafe content, and contradictions between photos. Separate blocking errors from warnings.

## Commercial requirements

- Multi-tenant SaaS
- Subscription and credit-based billing
- Plan limits and usage tracking
- Brand templates
- Consent and rights confirmation
- Generation history and audit logs
- Support/SLA operations
- Secure asset retention and deletion

## Product constraints

- The generated video is an AI visualization, not measured geometry or a captured walkthrough.
- Do not intentionally fabricate structural features, equipment, views, or additional rooms.
- Apply an AI-generated disclosure by default.
- Never publish without human approval.
- The customer warrants rights to uploaded photos.

## Initial KPIs

- First-generation completion rate ≥ 85%
- Upload-to-preview target ≤ 10 minutes
- Regeneration rate ≤ 40%
- Generation failure rate
- Cost per video
- Monthly retention
- Customer satisfaction