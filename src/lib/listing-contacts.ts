import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptPrivateData } from "@/lib/private-data";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

type ContactInput = {
  name?: string;
  email?: string;
  phone?: string;
};

type ListingContactInput = {
  organizationId: string;
  listingId: string;
  sourceId: string;
  sourceUrl?: string | null;
  publicationContext?: string | null;
  contactType: "owner" | "listing_agent" | "listing_office" | "property_manager" | "other";
  contact: ContactInput;
  provenance: "publicly_listed" | "provider_supplied" | "unverified";
};

function contactFingerprint(contactType: ListingContactInput["contactType"], contact: ContactInput) {
  const email = contact.email?.trim().toLocaleLowerCase("en");
  const phone = contact.phone?.replace(/[^\d+]/g, "");
  const identity = [email ? `email:${email}` : "", phone ? `phone:${phone}` : ""].filter(Boolean).join("|");
  return identity ? createHash("sha256").update(`${contactType}:${identity}`).digest("hex") : null;
}

export async function storeListingContact(supabase: SupabaseClient, input: ListingContactInput) {
  const contactFingerprintValue = contactFingerprint(input.contactType, input.contact);
  if (!contactFingerprintValue) return { error: null };
  const encrypted = encryptPrivateData(input.contact);
  const record = {
    organization_id: input.organizationId,
    listing_id: input.listingId,
    source_id: input.sourceId,
    contact_type: input.contactType,
    encrypted_payload: encrypted.ciphertext,
    encryption_iv: encrypted.iv,
    encryption_auth_tag: encrypted.authTag,
    key_version: encrypted.keyVersion,
    contact_fingerprint: contactFingerprintValue,
    source_url: input.sourceUrl ?? null,
    publication_context: input.publicationContext ?? null,
    verification_status: input.provenance,
    permission_status: "unknown",
    updated_at: new Date().toISOString(),
  };

  const { data: existing, error: lookupError } = await supabase.from("listing_contacts")
    .select("id,collected_at")
    .eq("listing_id", input.listingId)
    .eq("contact_fingerprint", contactFingerprintValue)
    .maybeSingle();
  if (lookupError) return { error: lookupError };
  if (existing) {
    const { error } = await supabase.from("listing_contacts").update(record)
      .eq("id", existing.id).eq("organization_id", input.organizationId);
    if (error) return { error };
  } else {
    const { error } = await supabase.from("listing_contacts").insert(record);
    if (error) return { error };
  }

  if (input.provenance === "publicly_listed") {
    const { error } = await supabase.from("listings")
      .update({ has_public_contact: true, has_contact_information: true })
      .eq("id", input.listingId)
      .eq("organization_id", input.organizationId);
    if (error) return { error };
  } else {
    const { error } = await supabase.from("listings")
      .update({ has_contact_information: true })
      .eq("id", input.listingId)
      .eq("organization_id", input.organizationId);
    if (error) return { error };
  }
  return { error: null };
}

export async function storeSubmittedContacts(input: {
  organizationId: string;
  listingId: string;
  sourceId: string;
  sourceUrl?: string | null;
  publicContactContext?: string;
  privateDetails: Record<string, string | undefined>;
}) {
  const supabase = getSupabaseAdminClient();
  if (!supabase) return { error: new Error("Server-side contact storage is not configured") };
  const groups: Array<{
    contactType: ListingContactInput["contactType"];
    contact: ContactInput;
  }> = [
    {
      contactType: "owner",
      contact: {
        name: input.privateDetails.ownerName,
        email: input.privateDetails.ownerEmail,
        phone: input.privateDetails.ownerPhone,
      },
    },
    {
      contactType: "listing_agent",
      contact: {
        name: input.privateDetails.listingAgentName,
        email: input.privateDetails.listingAgentEmail,
        phone: input.privateDetails.listingAgentPhone,
      },
    },
    {
      contactType: "listing_office",
      contact: {
        name: input.privateDetails.listingOfficeName,
        email: input.privateDetails.listingOfficeEmail,
        phone: input.privateDetails.listingOfficePhone,
      },
    },
  ];
  for (const group of groups) {
    if (!group.contact.name && !group.contact.email && !group.contact.phone) continue;
    const result = await storeListingContact(supabase, {
      organizationId: input.organizationId,
      listingId: input.listingId,
      sourceId: input.sourceId,
      sourceUrl: input.sourceUrl,
      publicationContext: input.publicContactContext ?? null,
      contactType: group.contactType,
      contact: group.contact,
      provenance: input.publicContactContext ? "publicly_listed" : "unverified",
    });
    if (result.error) return result;
  }
  return { error: null };
}
