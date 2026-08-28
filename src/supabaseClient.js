import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://wjzyywzlxvucaunpmlic.supabase.co";
const supabaseAnonKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indqenl5d3pseHZ1Y2F1bnBtbGljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5MjkwODksImV4cCI6MjEwMzUwNTA4OX0.Z0er5bEJzdkGrNJFM48yfYlI3s4-qR-A7umnKvGr61s";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
