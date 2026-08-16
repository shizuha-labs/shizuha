#!/usr/bin/env python3
"""Mock MCP server with 56 tools across 5 services for testing tool search.

Usage: python3 mock-mcp-server.py
Transport: stdio (used by MCP client in tests)
"""
from mcp.server.fastmcp import FastMCP

mcp = FastMCP(
    "mock-multi-service",
    instructions="Mock multi-service MCP server for testing. Provides CRM, billing, support, analytics, and calendar tools.",
)


# ── CRM Service (12 tools) ──

@mcp.tool(description="List all CRM contacts with optional filtering")
def crm_list_contacts(limit: int = 10, search: str = "") -> str:
    return f"Found {limit} contacts matching '{search}'"

@mcp.tool(description="Create a new CRM contact record")
def crm_create_contact(name: str, email: str, company: str = "") -> str:
    return f"Created contact: {name} ({email})"

@mcp.tool(description="Get CRM contact details by ID")
def crm_get_contact(contact_id: str) -> str:
    return f"Contact {contact_id}: John Doe (john@example.com)"

@mcp.tool(description="Update an existing CRM contact")
def crm_update_contact(contact_id: str, name: str = "", email: str = "") -> str:
    return f"Updated contact {contact_id}"

@mcp.tool(description="Delete a CRM contact")
def crm_delete_contact(contact_id: str) -> str:
    return f"Deleted contact {contact_id}"

@mcp.tool(description="List all CRM deals in the pipeline")
def crm_list_deals(stage: str = "", limit: int = 10) -> str:
    return f"Found {limit} deals in stage '{stage}'"

@mcp.tool(description="Create a new CRM deal")
def crm_create_deal(title: str, value: float, contact_id: str = "") -> str:
    return f"Created deal: {title} (${value})"

@mcp.tool(description="Get CRM deal details")
def crm_get_deal(deal_id: str) -> str:
    return f"Deal {deal_id}: Big Contract ($50000)"

@mcp.tool(description="Update a CRM deal")
def crm_update_deal(deal_id: str, stage: str = "", value: float = 0) -> str:
    return f"Updated deal {deal_id}"

@mcp.tool(description="List CRM activities and interactions")
def crm_list_activities(contact_id: str = "", limit: int = 10) -> str:
    return f"Found {limit} activities"

@mcp.tool(description="Search CRM contacts by name, email, or company")
def crm_search_contacts(query: str, limit: int = 10) -> str:
    return f"Found {limit} contacts matching '{query}'"

@mcp.tool(description="Get CRM sales pipeline overview")
def crm_get_pipeline() -> str:
    return "Pipeline: 5 leads, 3 qualified, 2 proposals, 1 closed"


# ── Billing Service (12 tools) ──

@mcp.tool(description="List all billing invoices")
def billing_list_invoices(status: str = "", limit: int = 10) -> str:
    return f"Found {limit} invoices with status '{status}'"

@mcp.tool(description="Create a new billing invoice")
def billing_create_invoice(customer_id: str, amount: float, currency: str = "USD") -> str:
    return f"Created invoice for ${amount} {currency}"

@mcp.tool(description="Get billing invoice details")
def billing_get_invoice(invoice_id: str) -> str:
    return f"Invoice {invoice_id}: $500.00 USD - Paid"

@mcp.tool(description="Send a billing invoice to the customer via email")
def billing_send_invoice(invoice_id: str, email: str = "") -> str:
    return f"Sent invoice {invoice_id}"

@mcp.tool(description="Void a billing invoice")
def billing_void_invoice(invoice_id: str, reason: str = "") -> str:
    return f"Voided invoice {invoice_id}"

@mcp.tool(description="List all billing payments received")
def billing_list_payments(status: str = "", limit: int = 10) -> str:
    return f"Found {limit} payments"

@mcp.tool(description="Record a new billing payment")
def billing_create_payment(invoice_id: str, amount: float, method: str = "card") -> str:
    return f"Recorded payment of ${amount}"

@mcp.tool(description="Get billing payment details")
def billing_get_payment(payment_id: str) -> str:
    return f"Payment {payment_id}: $500.00 via card"

@mcp.tool(description="List active subscriptions")
def billing_list_subscriptions(status: str = "active") -> str:
    return f"Found subscriptions with status '{status}'"

@mcp.tool(description="Create a new subscription")
def billing_create_subscription(customer_id: str, plan: str, interval: str = "monthly") -> str:
    return f"Created {interval} subscription to {plan}"

@mcp.tool(description="Cancel a subscription")
def billing_cancel_subscription(subscription_id: str, reason: str = "") -> str:
    return f"Cancelled subscription {subscription_id}"

@mcp.tool(description="Get billing revenue report")
def billing_get_revenue_report(period: str = "monthly") -> str:
    return f"Revenue report ({period}): $45,000"


# ── Support Service (11 tools) ──

@mcp.tool(description="List support tickets with optional filtering")
def support_list_tickets(status: str = "", priority: str = "", limit: int = 10) -> str:
    return f"Found {limit} tickets"

@mcp.tool(description="Create a new support ticket")
def support_create_ticket(subject: str, description: str, priority: str = "medium") -> str:
    return f"Created ticket: {subject}"

@mcp.tool(description="Get support ticket details")
def support_get_ticket(ticket_id: str) -> str:
    return f"Ticket {ticket_id}: Password reset issue - Open"

@mcp.tool(description="Update a support ticket")
def support_update_ticket(ticket_id: str, status: str = "", priority: str = "") -> str:
    return f"Updated ticket {ticket_id}"

@mcp.tool(description="Close a support ticket with resolution")
def support_close_ticket(ticket_id: str, resolution: str = "") -> str:
    return f"Closed ticket {ticket_id}"

@mcp.tool(description="Assign a support ticket to an agent")
def support_assign_ticket(ticket_id: str, agent_id: str) -> str:
    return f"Assigned ticket {ticket_id} to agent {agent_id}"

@mcp.tool(description="List support agents")
def support_list_agents(available: bool = True) -> str:
    return f"Found agents (available={available})"

@mcp.tool(description="Get support agent details")
def support_get_agent(agent_id: str) -> str:
    return f"Agent {agent_id}: Jane Smith - Online"

@mcp.tool(description="List support ticket categories")
def support_list_categories() -> str:
    return "Categories: billing, technical, account, general"

@mcp.tool(description="Search knowledge base articles")
def support_search_knowledge_base(query: str, limit: int = 5) -> str:
    return f"Found {limit} articles matching '{query}'"

@mcp.tool(description="Create a knowledge base article")
def support_create_article(title: str, content: str, category: str = "") -> str:
    return f"Created article: {title}"


# ── Analytics Service (11 tools) ──

@mcp.tool(description="Get analytics dashboard with key metrics")
def analytics_get_dashboard(period: str = "7d") -> str:
    return f"Dashboard ({period}): 1500 users, 85% retention"

@mcp.tool(description="List available analytics reports")
def analytics_list_reports(category: str = "") -> str:
    return "Reports: user-growth, revenue, churn, engagement"

@mcp.tool(description="Create a custom analytics report")
def analytics_create_report(name: str, metrics: str, period: str = "30d") -> str:
    return f"Created report: {name}"

@mcp.tool(description="Get analytics report results")
def analytics_get_report(report_id: str) -> str:
    return f"Report {report_id}: 25% growth MoM"

@mcp.tool(description="Export analytics report to CSV or PDF")
def analytics_export_report(report_id: str, format: str = "csv") -> str:
    return f"Exported report {report_id} as {format}"

@mcp.tool(description="List available analytics metrics")
def analytics_list_metrics(category: str = "") -> str:
    return "Metrics: dau, mau, revenue, churn_rate, nps"

@mcp.tool(description="Get a specific analytics metric value")
def analytics_get_metric(metric_name: str, period: str = "7d") -> str:
    return f"Metric {metric_name} ({period}): 1234"

@mcp.tool(description="Create an analytics alert rule")
def analytics_create_alert(metric: str, threshold: float, condition: str = "above") -> str:
    return f"Created alert: {metric} {condition} {threshold}"

@mcp.tool(description="List active analytics alerts")
def analytics_list_alerts(status: str = "active") -> str:
    return "Alerts: 2 active, 1 triggered"

@mcp.tool(description="Get funnel analysis for conversion tracking")
def analytics_get_funnel_analysis(funnel_name: str, period: str = "30d") -> str:
    return f"Funnel {funnel_name}: 100% → 45% → 20% → 5%"

@mcp.tool(description="Get cohort analysis for user retention")
def analytics_get_cohort_analysis(period: str = "weekly", cohort_size: int = 4) -> str:
    return f"Cohort analysis ({period}, {cohort_size} cohorts)"


# ── Calendar Service (10 tools) ──

@mcp.tool(description="List calendar events within a date range")
def calendar_list_events(start_date: str = "", end_date: str = "", limit: int = 10) -> str:
    return f"Found {limit} events"

@mcp.tool(description="Create a new calendar event")
def calendar_create_event(title: str, start: str, end: str, description: str = "") -> str:
    return f"Created event: {title} ({start} - {end})"

@mcp.tool(description="Get calendar event details")
def calendar_get_event(event_id: str) -> str:
    return f"Event {event_id}: Team standup - Daily 9am"

@mcp.tool(description="Update a calendar event")
def calendar_update_event(event_id: str, title: str = "", start: str = "", end: str = "") -> str:
    return f"Updated event {event_id}"

@mcp.tool(description="Delete a calendar event")
def calendar_delete_event(event_id: str) -> str:
    return f"Deleted event {event_id}"

@mcp.tool(description="List available calendars")
def calendar_list_calendars() -> str:
    return "Calendars: personal, work, team, holidays"

@mcp.tool(description="Share a calendar with another user")
def calendar_share_calendar(calendar_id: str, user_email: str, permission: str = "read") -> str:
    return f"Shared calendar {calendar_id} with {user_email}"

@mcp.tool(description="Get availability for scheduling")
def calendar_get_availability(user_id: str = "", date: str = "") -> str:
    return f"Available: 10am-12pm, 2pm-4pm"

@mcp.tool(description="Create a booking or appointment")
def calendar_create_booking(title: str, date: str, time: str, duration_minutes: int = 30) -> str:
    return f"Booked: {title} on {date} at {time} ({duration_minutes}min)"

@mcp.tool(description="Get my calendar identity and settings")
def calendar_get_my_identity() -> str:
    return "Calendar user: test@example.com, timezone: UTC"


if __name__ == "__main__":
    mcp.run(transport="stdio")
