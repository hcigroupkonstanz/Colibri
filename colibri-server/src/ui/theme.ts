import { definePreset } from '@primeng/themes';
import Material from '@primeng/themes/material';

// PrimeNG's dark colour scheme, always on (the app-dark class on <html>), with the surfaces taken
// from Nord so that its select and overlay match the rest of the page instead of being white.
export default definePreset(Material, {
    semantic: {
        primary: {
            50:  '#f5f7fa',
            100: '#e7edf3',
            200: '#cdd8e5',
            300: '#a1b5cf',
            400: '#88c0d0', // nord8
            500: '#5e81ac',
            600: '#4b6a91',
            700: '#3d5676',
            800: '#2d4058',
            900: '#1f2d3d',
            950: '#17202c'
        },
        // size="small": as high as the toolbar's other controls (32px)
        formField: {
            sm: {
                fontSize: '0.8125rem',
                paddingX: '0.625rem',
                paddingY: '0.4375rem'
            }
        },
        colorScheme: {
            dark: {
                surface: {
                    0: '#ffffff',
                    50: '#eceff4',  // nord6
                    100: '#e5e9f0', // nord5
                    200: '#d8dee9', // nord4
                    300: '#c0c8d6',
                    400: '#aab3c4',
                    500: '#8893a8',
                    600: '#77839b',
                    700: '#4c566a', // nord3
                    800: '#434c5e', // nord2
                    900: '#3b4252', // nord1
                    950: '#2e3440'  // nord0
                },
                formField: {
                    background: '{surface.950}',
                    borderColor: '{surface.600}',
                    hoverBorderColor: '{surface.400}',
                    color: '{surface.100}',
                    placeholderColor: '{surface.400}',
                    iconColor: '{surface.400}'
                },
                overlay: {
                    select: {
                        background: '{surface.900}',
                        borderColor: '{surface.700}'
                    }
                }
            }
        }
    },
    components: {
        toggleswitch: {
            colorScheme: {
                dark: {
                    root: {
                        background: '#4c566a',        // nord3
                        hoverBackground: '#4c566a',
                        checkedBackground: '#5e81ac',  // nord10
                        checkedHoverBackground: '#5e81ac'
                    },
                    handle: {
                        background: '#d8dee9',         // nord4
                        hoverBackground: '#eceff4',
                        checkedBackground: '#88c0d0',  // nord8
                        checkedHoverBackground: '#88c0d0'
                    }
                }
            }
        }
    }
});
