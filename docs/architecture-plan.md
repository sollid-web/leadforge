# LeadForge Architecture Plan

## Entities & Relationships

### Core Entities
1. **Lead**
   - Core record representing a potential real estate client
   - Fields: id, firstName, lastName, email, phone, source, status, score, createdAt, updatedAt
   - Relationships: belongs to one Agent (realtor), has many Activities, belongs to one Campaign

2. **Activity**
   - Any interaction with a lead (call, email, SMS, meeting, note)
   - Fields: id, leadId, type, subject, content, outcome, createdAt, updatedAt
   - Relationships: belongs to one Lead, optional belongs to one Automation

3. **Automation (Workflow)**
   - Rules-based automation for lead nurturing
   - Fields: id, name, description, trigger, actions, isActive, createdAt, updatedAt
   - Relationships: has many Activities, belongs to one Agent

4. **Campaign**
   - Grouping of leads for marketing/sales initiatives
   - Fields: id, name, description, startDate, endDate, status, createdAt, updatedAt
   - Relationships: has many Leads, belongs to one Agent

5. **Agent (User)**
   - Real estate agent using the platform
   - Fields: id, email, name, role, isActive, createdAt, updatedAt
   - Relationships: has many Leads, has many Activities, has many Automations, has many Campaigns

6. **Integration**
   - External system connections
   - Fields: id, type (gmail, supabase, n8n, etc.), config, credentials (encrypted), createdAt, updatedAt

### Authentication Approach
- **Provider**: Supabase Auth (email/password + OAuth providers)
- **Strategy**: JWT-based session management with httpOnly cookies
- **Security Boundaries**:
  - Public routes: /api/health, /login, /callback
  - Protected routes: /dashboard/* (all require authentication)
  - API routes: Row-level security via Supabase policies
  - Role-based access: Agent/Admin roles for feature gating

### Security Boundaries
1. **Network Layer**
   - Vercel Edge Functions / Serverless Functions
   - Rate limiting on auth and API endpoints
   - CORS restricted to frontend origin

2. **Data Layer**
   - Supabase Postgres with Row Level Security (RLS)
   - Encryption at rest for PII (email, phone)
   - Field-level encryption for sensitive data (SSN, financial info if collected)
   - API credentials stored encrypted in database

3. **Application Layer**
   - Input validation via Zod schemas
   - Output encoding to prevent XSS
   - CSRF protection on state-changing operations
   - Dependency scanning and updates

### Integration Points

#### Supabase
- **Database**: Primary relational data store for leads, activities, automations
- **Auth**: User authentication and session management
- **Storage**: File uploads (documents, images) - optional for future
- **Realtime**: Live updates for lead activity feeds
- **Functions**: Edge functions for webhook handling and complex operations

#### n8n
- **Workflow Engine**: Complex multi-step automations beyond simple rules
- **Triggers**: Webhook receiver for external events (form submissions, lead source updates)
- **Actions**: 
  - Send emails via Gmail/SMTP
  - Update CRM systems
  - Trigger SMS/WhatsApp messages
  - Enrich lead data via APIs
- **Deployment**: n8n workflow exports stored in `/src/n8n` as JSON
- **Communication**: 
  - LeadForge → n8n: HTTP API calls to trigger workflows
  - n8n → LeadForge: Webhooks to update lead status/activities

#### AI Provider (Vercel AI Gateway)
- **Lead Scoring**: Predictive lead quality scoring
- **Content Generation**: AI-generated follow-up messages/email templates
- **Intent Analysis**: Classification of lead inquiries and responses
- **Data Enrichment**: Suggested next-best-actions based on lead behavior
- **Privacy**: Zero data retention via AI Gateway; no PII stored/logged

#### Gmail Integration
- **Sync**: Two-way email sync for lead communications
- **Tracking**: Email open/click tracking (future)
- **Templates**: Saved email templates for common follow-ups
- **Scheduling**: Send-later and scheduled email campaigns

### Technology Stack
- **Frontend**: Next.js 15 (App Router), TypeScript, Tailwind CSS
- **Backend**: Next.js API Routes, Supabase (Postgres + Auth)
- **Automation**: n8n (self-hosted or managed)
- **AI**: Vercel AI Gateway for multi-provider access
- **Deployment**: Vercel (frontend + API routes)
- **Dev**: pnpm, ESLint, TypeScript strict mode

### Future Considerations
- **Multi-tenancy**: Separate workspaces for real estate teams/brokerages
- **Analytics**: Lead conversion funnel tracking, ROI reporting
- **Mobile**: PWA capabilities for offline lead capture
- **Compliance**: TCPA/GDPR readiness for communications