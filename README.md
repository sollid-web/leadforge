# LeadForge

LeadForge is a Next.js-based real estate lead intelligence platform designed to help sales teams manage inbound leads, score lead quality, review follow-ups, and coordinate outreach workflows. The product combines a protected dashboard, lead management views, workflow health indicators, and Supabase-backed data access in a modern SaaS-style architecture.

This project is best understood as a portfolio-ready MVP and product prototype. It demonstrates full-stack product thinking, route-level data validation, authentication patterns, dashboard design, and workflow orchestration concepts in a demo-safe environment.

## Project status

Status: MVP / prototype / functional product slice

This repository includes:
- a working dashboard shell for lead operations
- lead review and triage flows
- follow-up approval workflows
- Supabase-ready auth and data access patterns
- workflow and automation scaffolding
- demo-safe runtime behavior for local exploration without live credentials

Important boundaries:
- The app runs in demo mode when Supabase configuration is not present.
- Live Gmail and automation features remain behind approval gates.
- The project is intended for portfolio and learning use, not as a production-ready commercial SaaS platform.

## Live demo

No verified production deployment URL is included in the repository. The application is intended to run locally or in a hosted environment with the required Supabase setup.

## Engineering highlights

- Next.js 15 application using the App Router and TypeScript
- Supabase Auth and Postgres integration patterns
- Zod-validated API routes for lead creation and access control
- Demo-safe runtime fallback with explicit demo mode responses
- Deterministic lead scoring utility with evidence-based qualification logic
- Workflow orchestration templates for n8n ingestion
- Protected dashboard routes with environment-aware runtime behavior

## Features

### Implemented
- Dashboard shell for overview, leads, follow-ups, automations, and settings
- Lead list with search, filtering, pagination, qualification scoring, and status state
- Follow-up queue with human approval safeguards
- Automation health views for healthy, paused, and setup-required states
- Deterministic lead scoring with transparent scoring logic
- Supabase-ready schema and migration structure
- n8n workflow template for lead ingestion
- Demo mode fallback with read-only lead data when live credentials are absent
- Public auth flow for sign-in, sign-up, reset-password, and callback handling

### Partially implemented or unclear
- Full outbound workflow automation is still in progress
- Several product features are scaffolded or demo-backed rather than production-complete
- Gmail and AI-driven actions are intentionally gated

### Planned / not represented as complete
- Organization bootstrap and member invitation flow
- CSV import and bulk lead management APIs
- Full approval and audit flows for outbound messaging
- Production-grade AI provider abstraction and privacy-safe logging
- Live metrics and health reporting backed by production data

## Technology stack

### Frontend
- Next.js 15
- React 19
- TypeScript
- Tailwind CSS

### Backend
- Next.js App Router
- API routes
- Zod validation
- Supabase SSR integration

### Data and auth
- Supabase Auth
- Supabase Postgres
- Row-level security design
- Typed server-side lead APIs

### Automation and integrations
- n8n
- Gmail integration patterns
- Environment-aware demo/live runtime handling

## Architecture

LeadForge is a modern server-rendered application with a protected dashboard and authenticated access patterns. The system is designed around a real-estate lead operations model with Supabase as the primary auth and persistence layer.

```mermaid
flowchart LR
    User[Sales / Team Member] --> App[Next.js App]
    App --> Dashboard[Protected Dashboard Routes]
    App --> API[Next.js API Routes]
    API --> Supabase[(Supabase Auth + Postgres)]
    API --> Demo[Demo Fallback Data]
    App --> n8n[n8n Workflow Engine]
    App --> Gmail[Gmail Integration]
    Dashboard --> LeadData[Lead Scoring + Follow-up Workflow]
