export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      billing_line_items: {
        Row: {
          billing_period_id: string
          created_at: string
          device_id: string | null
          end_kwh: number | null
          household_id: string
          id: string
          start_kwh: number | null
          tier_breakdown: Json
          total_amount: number
          usage_kwh: number
        }
        Insert: {
          billing_period_id: string
          created_at?: string
          device_id?: string | null
          end_kwh?: number | null
          household_id: string
          id?: string
          start_kwh?: number | null
          tier_breakdown?: Json
          total_amount?: number
          usage_kwh?: number
        }
        Update: {
          billing_period_id?: string
          created_at?: string
          device_id?: string | null
          end_kwh?: number | null
          household_id?: string
          id?: string
          start_kwh?: number | null
          tier_breakdown?: Json
          total_amount?: number
          usage_kwh?: number
        }
        Relationships: [
          {
            foreignKeyName: "billing_line_items_billing_period_id_fkey"
            columns: ["billing_period_id"]
            isOneToOne: false
            referencedRelation: "billing_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_line_items_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_line_items_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "microgrid_shared_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_line_items_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_periods: {
        Row: {
          closed_at: string | null
          created_at: string
          end_date: string
          id: string
          microgrid_id: string
          start_date: string
          status: Database["public"]["Enums"]["billing_period_status"]
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          end_date: string
          id?: string
          microgrid_id: string
          start_date: string
          status?: Database["public"]["Enums"]["billing_period_status"]
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          end_date?: string
          id?: string
          microgrid_id?: string
          start_date?: string
          status?: Database["public"]["Enums"]["billing_period_status"]
        }
        Relationships: [
          {
            foreignKeyName: "billing_periods_microgrid_id_fkey"
            columns: ["microgrid_id"]
            isOneToOne: false
            referencedRelation: "microgrids"
            referencedColumns: ["id"]
          },
        ]
      }
      communities: {
        Row: {
          address_city: string | null
          address_country: string | null
          address_line1: string | null
          address_line2: string | null
          address_postal_code: string | null
          address_region: string | null
          created_at: string
          geography_notes: string | null
          id: string
          name: string
          org_id: string
        }
        Insert: {
          address_city?: string | null
          address_country?: string | null
          address_line1?: string | null
          address_line2?: string | null
          address_postal_code?: string | null
          address_region?: string | null
          created_at?: string
          geography_notes?: string | null
          id?: string
          name: string
          org_id: string
        }
        Update: {
          address_city?: string | null
          address_country?: string | null
          address_line1?: string | null
          address_line2?: string | null
          address_postal_code?: string | null
          address_region?: string | null
          created_at?: string
          geography_notes?: string | null
          id?: string
          name?: string
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "communities_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      devices: {
        Row: {
          config: Json
          created_at: string
          device_type: Database["public"]["Enums"]["device_type"]
          edge_id: string
          id: string
          name: string
          openems_component_id: string | null
        }
        Insert: {
          config?: Json
          created_at?: string
          device_type: Database["public"]["Enums"]["device_type"]
          edge_id: string
          id?: string
          name: string
          openems_component_id?: string | null
        }
        Update: {
          config?: Json
          created_at?: string
          device_type?: Database["public"]["Enums"]["device_type"]
          edge_id?: string
          id?: string
          name?: string
          openems_component_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "devices_edge_id_fkey"
            columns: ["edge_id"]
            isOneToOne: false
            referencedRelation: "edges"
            referencedColumns: ["id"]
          },
        ]
      }
      edges: {
        Row: {
          created_at: string
          data_source_type: Database["public"]["Enums"]["edge_data_source"]
          id: string
          microgrid_id: string
          name: string
          openems_backend_url: string | null
          openems_edge_id: string | null
          role: string | null
        }
        Insert: {
          created_at?: string
          data_source_type?: Database["public"]["Enums"]["edge_data_source"]
          id?: string
          microgrid_id: string
          name: string
          openems_backend_url?: string | null
          openems_edge_id?: string | null
          role?: string | null
        }
        Update: {
          created_at?: string
          data_source_type?: Database["public"]["Enums"]["edge_data_source"]
          id?: string
          microgrid_id?: string
          name?: string
          openems_backend_url?: string | null
          openems_edge_id?: string | null
          role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "edges_microgrid_id_fkey"
            columns: ["microgrid_id"]
            isOneToOne: false
            referencedRelation: "microgrids"
            referencedColumns: ["id"]
          },
        ]
      }
      household_devices: {
        Row: {
          created_at: string
          device_id: string
          household_id: string
          id: string
          role: Database["public"]["Enums"]["household_device_role"]
        }
        Insert: {
          created_at?: string
          device_id: string
          household_id: string
          id?: string
          role: Database["public"]["Enums"]["household_device_role"]
        }
        Update: {
          created_at?: string
          device_id?: string
          household_id?: string
          id?: string
          role?: Database["public"]["Enums"]["household_device_role"]
        }
        Relationships: [
          {
            foreignKeyName: "household_devices_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "household_devices_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "microgrid_shared_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "household_devices_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
        ]
      }
      household_users: {
        Row: {
          created_at: string
          household_id: string
          relationship: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          household_id: string
          relationship?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          household_id?: string
          relationship?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "household_users_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "household_users_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      households: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          created_at: string
          display_name: string
          id: string
          microgrid_id: string
          primary_email: string | null
          primary_phone: string | null
          unit_label: string | null
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          created_at?: string
          display_name: string
          id?: string
          microgrid_id: string
          primary_email?: string | null
          primary_phone?: string | null
          unit_label?: string | null
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          created_at?: string
          display_name?: string
          id?: string
          microgrid_id?: string
          primary_email?: string | null
          primary_phone?: string | null
          unit_label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "households_microgrid_id_fkey"
            columns: ["microgrid_id"]
            isOneToOne: false
            referencedRelation: "microgrids"
            referencedColumns: ["id"]
          },
        ]
      }
      meter_readings: {
        Row: {
          created_at: string
          device_id: string
          id: string
          read_at: string
          reading_kwh: number
        }
        Insert: {
          created_at?: string
          device_id: string
          id?: string
          read_at: string
          reading_kwh: number
        }
        Update: {
          created_at?: string
          device_id?: string
          id?: string
          read_at?: string
          reading_kwh?: number
        }
        Relationships: [
          {
            foreignKeyName: "meter_readings_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meter_readings_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "microgrid_shared_devices"
            referencedColumns: ["id"]
          },
        ]
      }
      microgrids: {
        Row: {
          address_city: string | null
          address_country: string | null
          address_line1: string | null
          address_line2: string | null
          address_postal_code: string | null
          address_region: string | null
          community_id: string
          created_at: string
          currency: string
          id: string
          lat: number | null
          lng: number | null
          name: string
        }
        Insert: {
          address_city?: string | null
          address_country?: string | null
          address_line1?: string | null
          address_line2?: string | null
          address_postal_code?: string | null
          address_region?: string | null
          community_id: string
          created_at?: string
          currency?: string
          id?: string
          lat?: number | null
          lng?: number | null
          name: string
        }
        Update: {
          address_city?: string | null
          address_country?: string | null
          address_line1?: string | null
          address_line2?: string | null
          address_postal_code?: string | null
          address_region?: string | null
          community_id?: string
          created_at?: string
          currency?: string
          id?: string
          lat?: number | null
          lng?: number | null
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "microgrids_community_id_fkey"
            columns: ["community_id"]
            isOneToOne: false
            referencedRelation: "communities"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          address_city: string | null
          address_country: string | null
          address_line1: string | null
          address_line2: string | null
          address_postal_code: string | null
          address_region: string | null
          created_at: string
          id: string
          name: string
        }
        Insert: {
          address_city?: string | null
          address_country?: string | null
          address_line1?: string | null
          address_line2?: string | null
          address_postal_code?: string | null
          address_region?: string | null
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          address_city?: string | null
          address_country?: string | null
          address_line1?: string | null
          address_line2?: string | null
          address_postal_code?: string | null
          address_region?: string | null
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      rate_schedules: {
        Row: {
          created_at: string
          id: string
          microgrid_id: string
          service_charge: number
          tax_rate: number
          tiers: Json
        }
        Insert: {
          created_at?: string
          id?: string
          microgrid_id: string
          service_charge?: number
          tax_rate?: number
          tiers?: Json
        }
        Update: {
          created_at?: string
          id?: string
          microgrid_id?: string
          service_charge?: number
          tax_rate?: number
          tiers?: Json
        }
        Relationships: [
          {
            foreignKeyName: "rate_schedules_microgrid_id_fkey"
            columns: ["microgrid_id"]
            isOneToOne: false
            referencedRelation: "microgrids"
            referencedColumns: ["id"]
          },
        ]
      }
      user_profiles: {
        Row: {
          created_at: string
          first_name: string | null
          last_name: string | null
          phone: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          first_name?: string | null
          last_name?: string | null
          phone?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          first_name?: string | null
          last_name?: string | null
          phone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["user_role"]
          scope_id: string | null
          scope_type: Database["public"]["Enums"]["role_scope_type"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["user_role"]
          scope_id?: string | null
          scope_type: Database["public"]["Enums"]["role_scope_type"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["user_role"]
          scope_id?: string | null
          scope_type?: Database["public"]["Enums"]["role_scope_type"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_scope_org_fkey"
            columns: ["scope_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_directory"
            referencedColumns: ["user_id"]
          },
        ]
      }
    }
    Views: {
      microgrid_recent_activity: {
        Row: {
          description: string | null
          kind: string | null
          microgrid_id: string | null
          timestamp: string | null
        }
        Relationships: []
      }
      microgrid_shared_devices: {
        Row: {
          config: Json | null
          created_at: string | null
          device_type: Database["public"]["Enums"]["device_type"] | null
          edge_id: string | null
          id: string | null
          microgrid_id: string | null
          name: string | null
          openems_component_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "devices_edge_id_fkey"
            columns: ["edge_id"]
            isOneToOne: false
            referencedRelation: "edges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edges_microgrid_id_fkey"
            columns: ["microgrid_id"]
            isOneToOne: false
            referencedRelation: "microgrids"
            referencedColumns: ["id"]
          },
        ]
      }
      user_directory: {
        Row: {
          email: string | null
          email_confirmed_at: string | null
          first_name: string | null
          last_name: string | null
          last_sign_in_at: string | null
          phone: string | null
          role: Database["public"]["Enums"]["user_role"] | null
          scope_id: string | null
          scope_type: Database["public"]["Enums"]["role_scope_type"] | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_scope_org_fkey"
            columns: ["scope_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      fn_change_user_role: {
        Args: {
          p_role: Database["public"]["Enums"]["user_role"]
          p_scope_id?: string
          p_user_id: string
        }
        Returns: undefined
      }
      fn_create_household_with_meter: {
        Args: {
          p_address_line1?: string
          p_address_line2?: string
          p_device_id: string
          p_display_name: string
          p_microgrid_id: string
          p_primary_email?: string
          p_primary_phone?: string
          p_unit_label?: string
        }
        Returns: string
      }
      fn_entity_delete_community: { Args: { p_id: string }; Returns: number }
      fn_entity_delete_edge: { Args: { p_id: string }; Returns: number }
      fn_entity_delete_microgrid: { Args: { p_id: string }; Returns: number }
      fn_entity_delete_org: { Args: { p_id: string }; Returns: number }
      fn_finalize_user_invitation: {
        Args: {
          p_first_name: string
          p_last_name: string
          p_phone: string
          p_role: Database["public"]["Enums"]["user_role"]
          p_scope_id?: string
          p_user_id: string
        }
        Returns: undefined
      }
      is_super_admin: { Args: never; Returns: boolean }
      user_can_access_microgrid: {
        Args: { _microgrid_id: string }
        Returns: boolean
      }
      user_can_access_org: { Args: { _org_id: string }; Returns: boolean }
      user_can_see_user_profile: {
        Args: { _target_user_id: string }
        Returns: boolean
      }
    }
    Enums: {
      billing_period_status: "draft" | "closed"
      device_type:
        | "consumption_meter"
        | "grid_meter"
        | "pv_meter"
        | "battery"
        | "inverter"
        | "ev_charger"
        | "other"
      edge_data_source: "openems" | "modbus_direct" | "mqtt" | "rest_api"
      household_device_role:
        | "primary_consumption_meter"
        | "secondary_meter"
        | "battery"
        | "solar"
        | "ev_charger"
        | "other"
      role_scope_type: "org"
      user_role: "super_admin" | "org_manager"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      billing_period_status: ["draft", "closed"],
      device_type: [
        "consumption_meter",
        "grid_meter",
        "pv_meter",
        "battery",
        "inverter",
        "ev_charger",
        "other",
      ],
      edge_data_source: ["openems", "modbus_direct", "mqtt", "rest_api"],
      household_device_role: [
        "primary_consumption_meter",
        "secondary_meter",
        "battery",
        "solar",
        "ev_charger",
        "other",
      ],
      role_scope_type: ["org"],
      user_role: ["super_admin", "org_manager"],
    },
  },
} as const

