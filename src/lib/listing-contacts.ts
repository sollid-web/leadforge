import type { SupabaseClient } from "@supabase/supabase-js";
import { contactFingerprint } from "@/lib/contact-identity";
import { encryptPrivateData } from "@/lib/private-data";

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

  const { error: contactError } = await supabase.from("listing_contacts")
    .upsert(record, { onConflict: "listing_id,contact_fingerprint" });
  if (contactError) return { error: contactError };

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
  supabase: SupabaseClient;
  organizationId: string;
  listingId: string;
  sourceId: string;
  sourceUrl?: string | null;
  publicContactContext?: string;
  privateDetails: Record<string, string | undefined>;
}) {
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
    {
      contactType: "other",
      contact: {
        name: input.privateDetails.otherContactName,
        email: input.privateDetails.otherContactEmail,
        phone: input.privateDetails.otherContactPhone,
      },
    },
  ];
  for (const group of groups) {
    if (!group.contact.name && !group.contact.email && !group.contact.phone) continue;
    const result = await storeListingContact(input.supabase, {
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
