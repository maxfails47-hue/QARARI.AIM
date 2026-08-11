-- Update users table to support new plan structure
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS current_plan_name text,
ADD COLUMN IF NOT EXISTS chat_messages_limit int DEFAULT 20,
ADD COLUMN IF NOT EXISTS chat_messages_used int DEFAULT 0,
ADD COLUMN IF NOT EXISTS price_alerts_limit int DEFAULT 0,
ADD COLUMN IF NOT EXISTS price_alerts_used int DEFAULT 0,
ADD COLUMN IF NOT EXISTS can_export_pdf boolean DEFAULT false;

-- Update the tier check constraint if needed (though we might keep tier for backward compatibility)
-- ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_tier_check;
-- ALTER TABLE public.users ADD CONSTRAINT users_tier_check CHECK (tier IN ('free', 'premium', 'small_bundle', 'medium_bundle', 'large_bundle', 'smart_shopper', 'power_buyer'));

-- Update subscription_requests to include new plans
ALTER TABLE public.subscription_requests 
DROP CONSTRAINT IF EXISTS subscription_requests_plan_check;

ALTER TABLE public.subscription_requests 
ADD CONSTRAINT subscription_requests_plan_check 
CHECK (plan IN ('monthly', 'annual', 'small_bundle', 'medium_bundle', 'large_bundle', 'smart_shopper', 'power_buyer'));
